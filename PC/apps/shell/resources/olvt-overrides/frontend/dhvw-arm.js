/* DHVW OLVT DOM semantic tagger & ARM adaptation controller.
   Uses unique structural landmarks (textarea/attach button + #live2d-internal-wrapper)
   so Sidebar media elements never mis-tag the main stage. */
(function () {
  var docEl = document.documentElement;
  var params;
  try {
    params = new URLSearchParams(window.location.search || '');
  } catch (e) {
    params = null;
  }

  var isEmbedded = false;
  try {
    isEmbedded = window.self !== window.top;
  } catch (e) {
    isEmbedded = true;
  }
  var isArm = Boolean(params && params.get('arm') === '1');

  docEl.classList.add('dhvw-cel');
  if (isArm) {
    docEl.classList.add('dhvw-arm');
    /* 2GB ARM 设备没有麦克风，也承受不起 onnxruntime VAD worker 的常驻内存。
       在应用初始化前拒绝音频 getUserMedia，避免 MicVAD 创建 ORT 线程池。 */
    try {
      var md = navigator.mediaDevices;
      if (md && typeof md.getUserMedia === 'function') {
        var origGum = md.getUserMedia.bind(md);
        md.getUserMedia = function (constraints) {
          if (constraints && constraints.audio) {
            return Promise.reject(new DOMException('ARM device has no microphone', 'NotAllowedError'));
          }
          return origGum(constraints);
        };
      }
    } catch (e) {}
  }

  try {
    if (!localStorage.getItem('i18nextLng')) {
      localStorage.setItem('i18nextLng', JSON.stringify('zh'));
    }
  } catch (e) {}

  var didAutoCollapseSidebar = false;

  function setAttr(el, name, value) {
    if (!el || el.nodeType !== 1) return;
    if (el.getAttribute(name) !== value) {
      el.setAttribute(name, value);
    }
  }

  function clearStaleAttr(root, selector, attr) {
    var nodes = root.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].removeAttribute(attr);
    }
  }

  function dispatchEnterToTextarea(textarea) {
    if (!textarea) return;
    var val = textarea.value || '';
    if (!val.trim()) {
      textarea.focus();
      return;
    }
    textarea.focus();
    var evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    });
    textarea.dispatchEvent(evt);
  }

  function ensureSendButton(textarea) {
    if (!textarea) return;
    var box = textarea.parentElement;
    if (!box) return;
    var host = box.parentElement;
    if (!host) return;
    if (host.querySelector('[data-dhvw="send-btn"]')) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-dhvw', 'send-btn');
    btn.setAttribute('aria-label', '发送');
    btn.textContent = '发送';
    btn.addEventListener('click', function () {
      var ta = host.querySelector('textarea');
      dispatchEnterToTextarea(ta);
    });
    host.appendChild(btn);
  }

  function bindBrokenBgImage(img) {
    if (!img || img.tagName !== 'IMG') return;
    if (!img.dataset.dhvwBound) {
      img.dataset.dhvwBound = '1';
      img.addEventListener('error', function () {
        img.setAttribute('data-dhvw-broken', '1');
      });
      img.addEventListener('load', function () {
        img.removeAttribute('data-dhvw-broken');
      });
    }
    if (img.complete && img.naturalWidth === 0) {
      img.setAttribute('data-dhvw-broken', '1');
    } else if (img.naturalWidth > 0) {
      img.removeAttribute('data-dhvw-broken');
    }
  }

  function findMainContentFromFooter(root) {
    var attachBtn = root.querySelector('[aria-label="Attach file"]');
    if (!attachBtn) return null;
    /* AppContent renders: #root > appContainer > mainContent > footerWrap > ... > attachBtn */
    var cur = attachBtn;
    var chain = [];
    while (cur && cur !== root) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    /* chain from attachBtn upward ends with [..., footerWrap, mainContent, appContainer] */
    if (chain.length < 4) return null;
    var appContainer = chain[chain.length - 1];
    var mainContent = chain[chain.length - 2];
    var footerWrap = chain[chain.length - 3];
    return {
      attachBtn: attachBtn,
      appContainer: appContainer,
      mainContent: mainContent,
      footerWrap: footerWrap
    };
  }

  function annotateSidebar(sidebarOuter) {
    if (!sidebarOuter) return;
    setAttr(sidebarOuter, 'data-dhvw', 'sidebar-outer');
    var sidebarInner = sidebarOuter.firstElementChild;
    if (!sidebarInner) return;
    setAttr(sidebarInner, 'data-dhvw', 'sidebar-inner');

    var toggleBtn = sidebarInner.firstElementChild;
    if (toggleBtn) {
      setAttr(toggleBtn, 'data-dhvw', 'sidebar-toggle');
      toggleBtn.setAttribute('title', '展开 / 收起侧边栏');
      var tf = (toggleBtn.style && toggleBtn.style.transform) || '';
      var collapsed = tf.indexOf('180deg') !== -1;
      setAttr(sidebarOuter, 'data-dhvw-collapsed', collapsed ? 'true' : 'false');
      docEl.setAttribute('data-dhvw-sidebar', collapsed ? 'collapsed' : 'open');

      if (isArm && !didAutoCollapseSidebar && !collapsed) {
        didAutoCollapseSidebar = true;
        setTimeout(function () {
          try {
            var currentTf = (toggleBtn.style && toggleBtn.style.transform) || '';
            if (currentTf.indexOf('180deg') === -1) {
              toggleBtn.click();
            }
          } catch (e) {}
        }, 0);
      }
    }

    var sidebarContent = toggleBtn ? toggleBtn.nextElementSibling : null;
    if (sidebarContent && !sidebarContent.getAttribute('role')) {
      setAttr(sidebarContent, 'data-dhvw', 'sidebar-content');
      var scChildren = sidebarContent.children;
      if (scChildren.length >= 1) {
        setAttr(scChildren[0], 'data-dhvw', 'sidebar-header');
        var headerBtns = scChildren[0].querySelectorAll('button');
        var titles = ['系统设置', '群组管理', '历史对话', '新建对话', '显示模式'];
        for (var b = 0; b < headerBtns.length && b < titles.length; b++) {
          if (!headerBtns[b].getAttribute('title')) {
            headerBtns[b].setAttribute('title', titles[b]);
          }
          if (b === 1) setAttr(headerBtns[b], 'data-dhvw', 'group-btn');
          if (b === 2) setAttr(headerBtns[b], 'data-dhvw', 'history-btn');
          if (b === 3) setAttr(headerBtns[b], 'data-dhvw', 'new-chat-btn');
        }
      }
      if (scChildren.length >= 2) {
        setAttr(scChildren[1], 'data-dhvw', 'chat-history-panel');
      }
      if (scChildren.length >= 3) {
        setAttr(scChildren[2], 'data-dhvw', 'bottom-tab');
      }
    }

    var modeMenuBtn = sidebarInner.querySelector('[aria-label="Mode Menu"]');
    if (modeMenuBtn) {
      setAttr(modeMenuBtn, 'data-dhvw', 'mode-menu');
    }
  }

  function annotateFooter(footerWrap, attachBtn) {
    setAttr(footerWrap, 'data-dhvw', 'footer-wrap');
    setAttr(attachBtn, 'data-dhvw', 'attach-btn');

    var footerCard = footerWrap.firstElementChild;
    if (footerCard) {
      setAttr(footerCard, 'data-dhvw', 'footer-card');
      var fToggle = footerCard.firstElementChild;
      if (fToggle) {
        setAttr(fToggle, 'data-dhvw', 'footer-toggle');
        fToggle.setAttribute('title', '收起 / 展开输入栏');
        var fTf = (fToggle.style && fToggle.style.transform) || '';
        var fCollapsed = fTf.indexOf('180deg') !== -1;
        setAttr(footerWrap, 'data-dhvw-collapsed', fCollapsed ? 'true' : 'false');
        setAttr(footerCard, 'data-dhvw-collapsed', fCollapsed ? 'true' : 'false');
      }
      var footerBody = fToggle ? fToggle.nextElementSibling : null;
      if (footerBody) {
        setAttr(footerBody, 'data-dhvw', 'footer-body');
        var footerRow = footerBody.firstElementChild;
        if (footerRow) {
          setAttr(footerRow, 'data-dhvw', 'footer-row');
          var leftGroup = footerRow.firstElementChild;
          if (leftGroup) {
            setAttr(leftGroup, 'data-dhvw', 'footer-actions-col');
            var aiStateWrap = leftGroup.firstElementChild;
            if (aiStateWrap && aiStateWrap.firstElementChild) {
              setAttr(aiStateWrap.firstElementChild, 'data-dhvw', 'ai-state');
            }
          }
        }
      }
    }

    var handBtn = footerWrap.querySelector('[aria-label="Raise hand"]');
    if (handBtn) {
      setAttr(handBtn, 'data-dhvw', 'hand-btn');
      handBtn.setAttribute('title', '举手 / 打断');
      if (handBtn.previousElementSibling) {
        setAttr(handBtn.previousElementSibling, 'data-dhvw', 'mic-btn');
        var micTitle = docEl.getAttribute('data-dhvw-mic-suspended') === '1'
          ? '点击激活麦克风（等待浏览器解锁音频）'
          : '麦克风开关';
        handBtn.previousElementSibling.setAttribute('title', micTitle);
      }
    }

    var ta = footerWrap.querySelector('textarea');
    if (ta) {
      var inputGroup = ta.parentElement && ta.parentElement.parentElement;
      if (inputGroup) {
        setAttr(inputGroup, 'data-dhvw', 'input-group');
      }
      ensureSendButton(ta);
    }
  }

  function annotateTree() {
    var root = document.getElementById('root');
    if (!root) return;

    var live2dWrap = root.querySelector('#live2d-internal-wrapper, #canvas');
    if (live2dWrap) {
      var stageWrap = live2dWrap.closest('#root > *');
      if (stageWrap) {
        setAttr(stageWrap, 'data-dhvw', 'live2d-stage');
      }
    }

    var found = findMainContentFromFooter(root);
    if (!found) return;

    var mainContent = found.mainContent;
    var appContainer = found.appContainer;
    var footerWrap = found.footerWrap;

    setAttr(appContainer, 'data-dhvw', 'app-container');
    setAttr(mainContent, 'data-dhvw', 'main-content');

    var sidebarOuter = mainContent.previousElementSibling;
    annotateSidebar(sidebarOuter);

    var children = mainContent.children;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child === footerWrap) {
        annotateFooter(footerWrap, found.attachBtn);
        continue;
      }
      if (i === 0) {
        setAttr(child, 'data-dhvw', 'bg-container');
        var bgImg = child.querySelector('img[alt="background"]');
        if (bgImg) bindBrokenBgImage(bgImg);
        continue;
      }
      if (i === 1) {
        setAttr(child, 'data-dhvw', 'ws-status-wrap');
        if (child.firstElementChild) {
          setAttr(child.firstElementChild, 'data-dhvw', 'ws-status');
        }
        continue;
      }
      if (i === 2) {
        setAttr(child, 'data-dhvw', 'subtitle-wrap');
        if (child.firstElementChild) {
          setAttr(child.firstElementChild, 'data-dhvw', 'subtitle-card');
        }
      }
    }
  }

  var rafPending = false;
  function scheduleAnnotate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      annotateTree();
    });
  }

  function ensureStylesheetLast() {
    var head = document.head;
    if (!head) return;
    var celLink = head.querySelector('link[href*="dhvw-cel.css"]');
    if (celLink && head.lastElementChild !== celLink) {
      head.appendChild(celLink);
    }
  }

  function startObserver() {
    ensureStylesheetLast();
    annotateTree();
    var target = document.getElementById('root') || document.body;
    if (!target || typeof MutationObserver === 'undefined') return;
    var obs = new MutationObserver(scheduleAnnotate);
    obs.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
})();
