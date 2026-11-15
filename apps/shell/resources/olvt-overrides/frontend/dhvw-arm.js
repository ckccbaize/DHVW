/* DHVW OLVT DOM semantic tagger & ARM adaptation controller.
   Works on top of the upstream prebuilt Vite/Chakra frontend without touching React bundle source. */
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
  var isArm = Boolean((params && params.get('arm') === '1') || isEmbedded);

  docEl.classList.add('dhvw-cel');
  if (isArm) {
    docEl.classList.add('dhvw-arm');
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

  function annotateTree() {
    var root = document.getElementById('root');
    if (!root) return;

    /* 1. Background image/video -> bg-container -> main-content -> app-container -> sidebar */
    var bgMedia = root.querySelector('img[alt="background"], video');
    if (bgMedia) {
      if (bgMedia.tagName === 'IMG') {
        if (!bgMedia.dataset.dhvwBound) {
          bgMedia.dataset.dhvwBound = '1';
          bgMedia.addEventListener('error', function () {
            bgMedia.setAttribute('data-dhvw-broken', '1');
          });
          bgMedia.addEventListener('load', function () {
            bgMedia.removeAttribute('data-dhvw-broken');
          });
        }
        if (bgMedia.complete && bgMedia.naturalWidth === 0) {
          bgMedia.setAttribute('data-dhvw-broken', '1');
        } else if (bgMedia.naturalWidth > 0) {
          bgMedia.removeAttribute('data-dhvw-broken');
        }
      }
      var bgContainer = bgMedia.parentElement;
      setAttr(bgContainer, 'data-dhvw', 'bg-container');

      var mainContent = bgContainer && bgContainer.parentElement;
      if (mainContent) {
        setAttr(mainContent, 'data-dhvw', 'main-content');
        var appContainer = mainContent.parentElement;
        if (appContainer) {
          setAttr(appContainer, 'data-dhvw', 'app-container');
          var live2dStage = appContainer.previousElementSibling;
          if (live2dStage && live2dStage.querySelector('#canvas, canvas')) {
            setAttr(live2dStage, 'data-dhvw', 'live2d-stage');
          }
        }
        var sidebarOuter = mainContent.previousElementSibling;
        if (sidebarOuter) {
          setAttr(sidebarOuter, 'data-dhvw', 'sidebar-outer');
          var sidebarInner = sidebarOuter.firstElementChild;
          if (sidebarInner) {
            setAttr(sidebarInner, 'data-dhvw', 'sidebar-inner');
            var toggleBtn = sidebarInner.firstElementChild;
            if (toggleBtn) {
              setAttr(toggleBtn, 'data-dhvw', 'sidebar-toggle');
              var tf = (toggleBtn.style && toggleBtn.style.transform) || '';
              var collapsed = tf.indexOf('180deg') !== -1 || sidebarOuter.offsetWidth <= 40;
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
            var modeMenuBtn = sidebarInner.querySelector('[aria-label="Mode Menu"]');
            if (modeMenuBtn) {
              setAttr(modeMenuBtn, 'data-dhvw', 'mode-menu');
            }
          }
        }

        /* 2. Children of mainContent: [bgContainer, wsStatusWrap, subtitleWrap, footerWrap] */
        var children = mainContent.children;
        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          if (child === bgContainer) continue;
          var ta = child.querySelector('textarea');
          if (ta) {
            setAttr(child, 'data-dhvw', 'footer-wrap');
            var footerCard = child.firstElementChild;
            if (footerCard) {
              setAttr(footerCard, 'data-dhvw', 'footer-card');
              var fToggle = footerCard.firstElementChild;
              if (fToggle) {
                setAttr(fToggle, 'data-dhvw', 'footer-toggle');
                var fTf = (fToggle.style && fToggle.style.transform) || '';
                var fCollapsed = fTf.indexOf('180deg') !== -1;
                setAttr(child, 'data-dhvw-collapsed', fCollapsed ? 'true' : 'false');
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
            var handBtn = child.querySelector('[aria-label="Raise hand"]');
            if (handBtn) {
              setAttr(handBtn, 'data-dhvw', 'hand-btn');
              if (handBtn.previousElementSibling) {
                setAttr(handBtn.previousElementSibling, 'data-dhvw', 'mic-btn');
              }
            }
            var attachBtn = child.querySelector('[aria-label="Attach file"]');
            if (attachBtn) {
              setAttr(attachBtn, 'data-dhvw', 'attach-btn');
            }
            var inputGroup = ta.parentElement && ta.parentElement.parentElement;
            if (inputGroup) {
              setAttr(inputGroup, 'data-dhvw', 'input-group');
            }
            ensureSendButton(ta);
            continue;
          }

          /* WebSocket status wrapper sits near top-left (i === 1) before subtitleWrap */
          if (i === 1 && !child.getAttribute('data-dhvw')) {
            setAttr(child, 'data-dhvw', 'ws-status-wrap');
            if (child.firstElementChild) {
              setAttr(child.firstElementChild, 'data-dhvw', 'ws-status');
            }
            continue;
          }

          if (i === 2 && !child.getAttribute('data-dhvw')) {
            setAttr(child, 'data-dhvw', 'subtitle-wrap');
          }
          if (child.getAttribute('data-dhvw') === 'subtitle-wrap' && child.firstElementChild) {
            setAttr(child.firstElementChild, 'data-dhvw', 'subtitle-card');
          }
        }
      }
    }

    var live2dCanvas = document.getElementById('canvas');
    if (live2dCanvas) {
      var stageWrap = live2dCanvas.closest('#root > div');
      if (stageWrap) {
        setAttr(stageWrap, 'data-dhvw', 'live2d-stage');
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

  function startObserver() {
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
