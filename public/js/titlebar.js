/**
 * Custom window titlebar for the frameless Tauri shell.
 *
 * The header in index.html carries `data-tauri-drag-region` (drag + double-click
 * maximize is injected by Tauri core on desktop). This module wires the three
 * window-control buttons and hides them in a plain browser. The webview runs on
 * a loopback (remote) origin, so it falls back to `__TAURI_INTERNALS__.invoke`
 * when the optional global `@tauri-apps/api/window` handle is not exposed.
 */

const container = document.querySelector('.window-controls');
const maximizeBtn = document.querySelector('#btn-win-maximize');

/** Desktop detection: Tauri injects __TAURI_INTERNALS__; plain browsers don't have it. */
const internals = window.__TAURI_INTERNALS__;

if (!internals) {
  container?.remove();
} else {
  // Apply the macOS safe area before the async platform command returns so the
  // native traffic lights never flash over the page header at startup.
  if (/Macintosh|Mac OS X/.test(navigator.userAgent)) {
    document.documentElement.classList.add('platform-macos');
  }
  init(internals);
}

function init(invokeChannel) {
  const coreInvoke = invokeChannel.invoke?.bind(invokeChannel);

  // Platform-specific chrome: macOS keeps the native traffic lights (no custom
  // buttons, CSS pads the header); Windows/Linux get the custom controls.
  coreInvoke?.('desktop_platform')
    .then((platform) => {
      if (typeof platform === 'string' && platform) {
        document.documentElement.classList.add(`platform-${platform}`);
      }
    })
    .catch(() => {});

  // With `withGlobalTauri` enabled the core exposes `window.__TAURI__.window`;
  // grab its handle when available, otherwise talk to the shell's own command.
  let appWindow = null;
  try {
    appWindow = window.__TAURI__?.window?.getCurrentWindow?.() ?? null;
  } catch {
    appWindow = null;
  }

  const call = async (action) => {
    try {
      if (appWindow) {
        if (action === 'minimize') await appWindow.minimize();
        else if (action === 'toggle-maximize') await appWindow.toggleMaximize();
        else if (action === 'close') await appWindow.close();
        return;
      }
      if (coreInvoke) await coreInvoke('window_control', { action });
    } catch (err) {
      console.warn(`window control "${action}" failed`, err);
    }
  };

  for (const btn of container.querySelectorAll('.win-btn')) {
    const action =
      btn.id === 'btn-win-minimize'
        ? 'minimize'
        : btn.id === 'btn-win-maximize'
          ? 'toggle-maximize'
          : 'close';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      void call(action);
    });
  }

  // Swap the maximize icon while maximized; title is informative only.
  const syncMaximized = async () => {
    if (!maximizeBtn) return;
    let maximized = false;
    try {
      if (appWindow) maximized = await appWindow.isMaximized();
    } catch {
      maximized = false;
    }
    maximizeBtn.classList.toggle('is-maximized', maximized);
    maximizeBtn.title = maximized ? '还原' : '最大化';
    maximizeBtn.setAttribute('aria-label', maximized ? '还原窗口' : '最大化窗口');
  };

  void syncMaximized();
  window.addEventListener('resize', () => void syncMaximized());
}
