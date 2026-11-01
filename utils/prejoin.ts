const joinLabels = new Set(['今すぐ参加', '参加をリクエスト', 'Join now', 'Ask to join']);
const devices = [
  {
    on: /^(?:マイクをオフにする|Turn off microphone)(?:\s|（|\(|$)/,
    off: /^(?:マイクをオンにする|Turn on microphone)(?:\s|（|\(|$)/,
  },
  {
    on: /^(?:カメラをオフにする|Turn off camera)(?:\s|（|\(|$)/,
    off: /^(?:カメラをオンにする|Turn on camera)(?:\s|（|\(|$)/,
  },
];

export function createPrejoinMuter(): () => void {
  const handled = new Set<number>();
  let meetingPath = '';

  return () => {
    if (meetingPath !== location.pathname) {
      meetingPath = location.pathname;
      handled.clear();
    }
    if (!location.pathname.startsWith('/meet/')) return;

    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('button, [role="button"]'),
    ).filter(
      (button) =>
        button.checkVisibility({ visibilityProperty: true, opacityProperty: true }) &&
        !button.matches(':disabled, [aria-disabled="true"]'),
    );
    const label = (button: HTMLElement) =>
      (button.getAttribute('aria-label') ?? button.innerText).trim();
    // A confirmed in-call screen ends the previous prejoin session. A temporarily
    // missing join button during rendering must not undo the user's later choice.
    if (
      buttons.some((button) => /^(?:通話から退出|Leave call)(?:\s|（|\(|$)/.test(label(button)))
    ) {
      handled.clear();
      return;
    }
    if (
      !buttons.some(
        (button) => joinLabels.has(button.innerText.trim()) || joinLabels.has(label(button)),
      )
    )
      return;

    devices.forEach((device, index) => {
      if (handled.has(index)) return;
      const button = buttons.find(
        (candidate) => device.on.test(label(candidate)) || device.off.test(label(candidate)),
      );
      if (!button) return;
      // Record already-muted devices too, so manually enabling one stays possible.
      handled.add(index);
      if (device.on.test(label(button))) button.click();
    });
  };
}
