// System / Desktop Notifications helper for Jishnu Support

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission(): NotificationPermissionState {
  if (!isNotificationSupported()) return "unsupported";
  return window.Notification.permission as NotificationPermissionState;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNotificationSupported()) return "unsupported";
  try {
    const permission = await window.Notification.requestPermission();
    return permission as NotificationPermissionState;
  } catch {
    return getNotificationPermission();
  }
}

/**
 * Register Service Worker to enable background notification clicks even when the tab is inactive.
 */
export async function registerNotificationServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return registration;
  } catch (err) {
    console.debug("Service worker registration skipped:", err);
    return null;
  }
}

/**
 * Play an audible chime using Web Audio API (no external MP3/WAV download required).
 */
export function playNotificationSound(): void {
  if (typeof window === "undefined") return;
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = "sine";
    osc1.frequency.setValueAtTime(587.33, now); // D5 tone
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.12); // ramp to A5

    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(880, now + 0.12); // harmonic A5

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.14);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc1.stop(now + 0.22);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.42);

    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 600);
  } catch {
    // Non-critical if audio is blocked by browser policy prior to user interaction
  }
}

export type SystemNotificationOptions = {
  title: string;
  body: string;
  ticketId?: number | null;
  view?: string;
  tag?: string;
  onClick?: () => void;
  playChime?: boolean;
};

/**
 * Trigger an OS / Desktop system notification.
 * Works even when the browser is minimized or user is on another platform/application.
 */
export async function triggerSystemNotification({
  title,
  body,
  ticketId,
  view,
  tag,
  onClick,
  playChime = true,
}: SystemNotificationOptions): Promise<void> {
  if (playChime) {
    playNotificationSound();
  }

  if (!isNotificationSupported()) return;
  if (window.Notification.permission !== "granted") return;

  const icon = "/jishnu-infotech-favicon.png";
  const badge = "/jishnu-infotech-favicon.png";
  const uniqueTag = tag || (ticketId ? `ticket-${ticketId}-${Date.now()}` : `jit-notif-${Date.now()}`);

  let notificationShown = false;

  // 1. Try native desktop window.Notification first (immediate, reliable, never hangs)
  try {
    const notif = new window.Notification(title, {
      body,
      icon,
      badge,
      tag: uniqueTag,
      data: { ticketId, view },
    });
    notif.onclick = () => {
      window.focus();
      if (onClick) onClick();
      notif.close();
    };
    notificationShown = true;
  } catch (desktopErr) {
    console.debug("window.Notification not permitted, attempting ServiceWorker fallback:", desktopErr);
  }

  // 2. If not shown yet (e.g. mobile Android which requires Service Worker), try Service Worker with a strict timeout
  if (!notificationShown && "serviceWorker" in navigator) {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
      ]);
      if (reg && "showNotification" in reg) {
        await reg.showNotification(title, {
          body,
          icon,
          badge,
          tag: uniqueTag,
          data: { ticketId, view },
        });
      }
    } catch (swErr) {
      console.debug("ServiceWorker showNotification failed:", swErr);
    }
  }
}

/**
 * Creates an unthrottled background heartbeat timer using Web Worker.
 * When the browser tab is in the background or minimized, main thread setInterval is heavily throttled by Chrome/Edge.
 * Web Workers run continuously, ensuring notifications are delivered immediately when working on other platforms.
 */
export function createBackgroundHeartbeat(onTick: () => void, intervalMs = 10000): { stop: () => void } {
  if (typeof window === "undefined") {
    return { stop: () => {} };
  }

  try {
    const workerBlob = new Blob(
      [
        `
        let timer = null;
        self.onmessage = function(e) {
          if (e.data.action === 'start') {
            if (timer) clearInterval(timer);
            timer = setInterval(() => { self.postMessage('tick'); }, e.data.interval || 10000);
          } else if (e.data.action === 'stop') {
            if (timer) clearInterval(timer);
            timer = null;
          }
        };
      `,
      ],
      { type: "application/javascript" }
    );
    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);

    worker.onmessage = () => {
      onTick();
    };

    worker.postMessage({ action: "start", interval: intervalMs });

    return {
      stop: () => {
        try {
          worker.postMessage({ action: "stop" });
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
        } catch {}
      },
    };
  } catch {
    const timerId = window.setInterval(onTick, intervalMs);
    return {
      stop: () => window.clearInterval(timerId),
    };
  }
}
