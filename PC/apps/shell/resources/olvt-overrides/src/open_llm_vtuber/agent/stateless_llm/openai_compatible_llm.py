"""Description: This file contains the implementation of the `AsyncLLM` class.
This class is responsible for handling asynchronous interaction with OpenAI API compatible
endpoints for language generation.
"""

from typing import AsyncIterator, List, Dict, Any
import asyncio
import json
import os

from openai import (
    AsyncStream,
    AsyncOpenAI,
    APIError,
    APIConnectionError,
    RateLimitError,
    NotGiven,
    NOT_GIVEN,
)
from openai.types.chat import ChatCompletionChunk
from openai.types.chat.chat_completion_chunk import ChoiceDeltaToolCall
from loguru import logger

from .stateless_llm_interface import StatelessLLMInterface
from ...mcpp.types import ToolCallObject


def _is_local_llama_endpoint(base_url: str, model: str) -> bool:
    """判断是否为本地部署的 llama/Nemotron/Gemma 推理服务。"""
    b = (base_url or "").strip().lower()
    m = (model or "").strip().lower()
    if any(k in m for k in ("nemotron", "gemma")):
        return True
    if "/llm/" in b or "/dhvw/llm/" in b:
        return True
    return any(h in b for h in ("127.0.0.1", "localhost", "0.0.0.0", "[::1]"))


class AsyncLLM(StatelessLLMInterface):
    def __init__(
        self,
        model: str,
        base_url: str,
        llm_api_key: str = "z",
        organization_id: str = "z",
        project_id: str = "z",
        temperature: float = 1.0,
    ):
        """
        Initializes an instance of the `AsyncLLM` class.

        Parameters:
        - model (str): The model to be used for language generation.
        - base_url (str): The base URL for the OpenAI API.
        - organization_id (str, optional): The organization ID for the OpenAI API. Defaults to "z".
        - project_id (str, optional): The project ID for the OpenAI API. Defaults to "z".
        - llm_api_key (str, optional): The API key for the OpenAI API. Defaults to "z".
        - temperature (float, optional): What sampling temperature to use, between 0 and 2. Defaults to 1.0.
        """
        self.base_url = base_url
        self.model = model
        self._is_local_llama = _is_local_llama_endpoint(base_url, model)
        self.temperature = (
            max(float(temperature or 1.0), 1.05) if self._is_local_llama else temperature
        )
        # [DHVW 补丁] 端点（codex.mintcat.work 等）无浏览器 UA 直接 403。
        # 可用 OLVT_LLM_USER_AGENT 覆盖，便于换端点时不改代码。
        ua = os.getenv("OLVT_LLM_USER_AGENT") or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
        )
        self.client = AsyncOpenAI(
            base_url=base_url,
            organization=organization_id,
            project=project_id,
            api_key=llm_api_key,
            default_headers={"User-Agent": ua},
            # [DHVW 补丁] 默认 600 s 无超时，遇到半死连接会一直挂着不出声；
            # 20 s 足够慢端点出首字，超时交给上层重试。
            timeout=20.0,
            max_retries=0,
        )
        self.support_tools = True

        # [DHVW 补丁] 透传额外请求体参数，用于关闭思考模型的 reasoning。
        # 上游未开放该能力，实测 deepseek 思考会吃掉 1-2s 首字延迟，且思考内容无法出声。
        # 用法：环境变量 OLVT_LLM_EXTRA_BODY='{"reasoning_effort":"none"}'
        self.extra_body = None
        _extra = os.getenv("OLVT_LLM_EXTRA_BODY")
        if _extra:
            try:
                parsed_extra = json.loads(_extra)
                if isinstance(parsed_extra, dict) and self._is_local_llama:
                    # 本地 llama 不关闭思考，以免降低回答质量与输出欲望
                    if str(parsed_extra.get("reasoning_effort") or "").strip().lower() == "none":
                        parsed_extra.pop("reasoning_effort", None)
                    if parsed_extra.get("enable_thinking") is False:
                        parsed_extra.pop("enable_thinking", None)
                    if parsed_extra.get("reasoning_budget") == 0:
                        parsed_extra.pop("reasoning_budget", None)
                self.extra_body = parsed_extra or None
                if self.extra_body:
                    logger.info(f"[DHVW] LLM extra_body applied: {self.extra_body}")
            except json.JSONDecodeError as exc:
                logger.warning(f"[DHVW] OLVT_LLM_EXTRA_BODY 不是合法 JSON，忽略: {exc}")

        logger.info(
            f"Initialized AsyncLLM with the parameters: {self.base_url}, {self.model}"
        )

    async def _create_stream(self, messages_with_system, available_tools):
        """[DHVW 补丁] 建立流式请求；连接类错误按 0.5/1.0 s 退避重试。

        只在尚未吐字前重试，因此不会重复输出半句话。
        """
        last: Exception | None = None
        for attempt in range(1, 4):
            try:
                return await self.client.chat.completions.create(
                    messages=messages_with_system,
                    model=self.model,
                    stream=True,
                    temperature=self.temperature,
                    tools=available_tools,
                    extra_body=self.extra_body,  # [DHVW 补丁] 关闭思考等额外参数
                )
            except APIConnectionError as exc:
                last = exc
                if attempt == 3:
                    raise
                await asyncio.sleep(0.5 * attempt)
                logger.warning(
                    f"[DHVW] LLM 连接失败，第 {attempt} 次重试：{exc.__cause__}"
                )
        raise last  # pragma: no cover

    async def chat_completion(
        self,
        messages: List[Dict[str, Any]],
        system: str = None,
        tools: List[Dict[str, Any]] | NotGiven = NOT_GIVEN,
    ) -> AsyncIterator[str | List[ChoiceDeltaToolCall]]:
        """
        Generates a chat completion using the OpenAI API asynchronously.

        Parameters:
        - messages (List[Dict[str, Any]]): The list of messages to send to the API.
        - system (str, optional): System prompt to use for this completion.
        - tools (List[Dict[str, str]], optional): List of tools to use for this completion.

        Yields:
        - str: The content of each chunk from the API response.
        - List[ChoiceDeltaToolCall]: The tool calls detected in the response.

        Raises:
        - APIConnectionError: When the server cannot be reached
        - RateLimitError: When a 429 status code is received
        - APIError: For other API-related errors
        """
        stream = None
        # Tool call related state variables
        accumulated_tool_calls = {}
        in_tool_call = False

        try:
            # If system prompt is provided, add it to the messages
            messages_with_system = messages
            if system:
                messages_with_system = [
                    {"role": "system", "content": system},
                    *messages,
                ]
            logger.debug(f"Messages: {messages_with_system}")

            available_tools = tools if self.support_tools else NOT_GIVEN

            # [DHVW 补丁] 首次连接失败（跨境网络抖动）重试 3 次，总等待约 3 s，
            # 避免一句「连接失败」就被当成回复念出来。
            stream: AsyncStream[ChatCompletionChunk] = await self._create_stream(
                messages_with_system, available_tools
            )
            logger.debug(
                f"Tool Support: {self.support_tools}, Available tools: {available_tools}"
            )

            async for chunk in stream:
                # Guard against chunks with missing choices field (e.g., from OpenWebUI)
                if not chunk.choices:
                    continue

                if self.support_tools:
                    has_tool_calls = (
                        hasattr(chunk.choices[0].delta, "tool_calls")
                        and chunk.choices[0].delta.tool_calls
                    )

                    if has_tool_calls:
                        logger.debug(
                            f"Tool calls detected in chunk: {chunk.choices[0].delta.tool_calls}"
                        )
                        in_tool_call = True
                        # Process tool calls in the current chunk
                        for tool_call in chunk.choices[0].delta.tool_calls:
                            index = (
                                tool_call.index if hasattr(tool_call, "index") else 0
                            )

                            # Initialize tool call for this index if needed
                            if index not in accumulated_tool_calls:
                                accumulated_tool_calls[index] = {
                                    "index": index,
                                    "id": getattr(tool_call, "id", None),
                                    "type": getattr(tool_call, "type", None),
                                    "function": {"name": "", "arguments": ""},
                                }

                            # Update tool call information
                            if hasattr(tool_call, "id") and tool_call.id:
                                accumulated_tool_calls[index]["id"] = tool_call.id
                            if hasattr(tool_call, "type") and tool_call.type:
                                accumulated_tool_calls[index]["type"] = tool_call.type

                            # Update function information
                            if hasattr(tool_call, "function"):
                                if (
                                    hasattr(tool_call.function, "name")
                                    and tool_call.function.name
                                ):
                                    accumulated_tool_calls[index]["function"][
                                        "name"
                                    ] = tool_call.function.name
                                if (
                                    hasattr(tool_call.function, "arguments")
                                    and tool_call.function.arguments
                                ):
                                    accumulated_tool_calls[index]["function"][
                                        "arguments"
                                    ] += tool_call.function.arguments

                        continue

                    # If we were in a tool call but now we're not, yield the tool call result
                    elif in_tool_call and not has_tool_calls:
                        in_tool_call = False
                        # Convert accumulated tool calls to the required format and output
                        logger.info(f"Complete tool calls: {accumulated_tool_calls}")

                        # Use the from_dict method to create a ToolCallObject instance from a dictionary
                        complete_tool_calls = [
                            ToolCallObject.from_dict(tool_data)
                            for tool_data in accumulated_tool_calls.values()
                        ]

                        yield complete_tool_calls
                        accumulated_tool_calls = {}  # Reset for potential future tool calls

                # Process regular content chunks
                if len(chunk.choices) == 0:
                    logger.info("Empty chunk received")
                    continue
                elif chunk.choices[0].delta.content is None:
                    chunk.choices[0].delta.content = ""
                yield chunk.choices[0].delta.content

            # If stream ends while still in a tool call, make sure to yield the tool call
            if in_tool_call and accumulated_tool_calls:
                logger.info(f"Final tool call at stream end: {accumulated_tool_calls}")

                # Create a ToolCallObject instance from a dictionary using the from_dict method.
                complete_tool_calls = [
                    ToolCallObject.from_dict(tool_data)
                    for tool_data in accumulated_tool_calls.values()
                ]

                yield complete_tool_calls

        except APIConnectionError as e:
            logger.error(
                f"Error calling the chat endpoint: Connection error. Failed to connect to the LLM API. \nCheck the configurations and the reachability of the LLM backend. \nSee the logs for details. \nTroubleshooting with documentation: https://open-llm-vtuber.github.io/docs/faq#%E9%81%87%E5%88%B0-error-calling-the-chat-endpoint-%E9%94%99%E8%AF%AF%E6%80%8E%E4%B9%88%E5%8A%9E \n{e.__cause__}"
            )
            # [DHVW 补丁] 下行文本会被直接送进 TTS，必须是给人听的中文，不能是英文堆栈
            yield "抱歉，我暂时连不上语言模型，请检查网络或设置里的端点。"  # 补丁

        except RateLimitError as e:
            logger.error(
                f"Error calling the chat endpoint: Rate limit exceeded: {e.response}"
            )
            yield "Error calling the chat endpoint: Rate limit exceeded. Please try again later. See the logs for details."

        except APIError as e:
            if "does not support tools" in str(e):
                self.support_tools = False
                logger.warning(
                    f"{self.model} does not support tools. Disabling tool support."
                )
                yield "__API_NOT_SUPPORT_TOOLS__"
                return
            logger.error(f"LLM API: Error occurred: {e}")
            logger.info(f"Base URL: {self.base_url}")
            logger.info(f"Model: {self.model}")
            logger.info(f"Messages: {messages}")
            logger.info(f"temperature: {self.temperature}")
            yield "Error calling the chat endpoint: Error occurred while generating response. See the logs for details."

        finally:
            # make sure the stream is properly closed
            # so when interrupted, no more tokens will being generated.
            if stream:
                logger.debug("Chat completion finished.")
                await stream.close()
                logger.debug("Stream closed.")
