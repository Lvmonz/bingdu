export async function unavailablePageMessage(url) {
  if (!url || url.startsWith('file:')) {
    const allowed = await chrome.extension.isAllowedFileSchemeAccess();
    if (!allowed) {
      const hint = '在「管理扩展程序」的并读详情中开启「允许访问文件网址」，然后刷新本地网页。';
      return url ? hint : '如果打开的是本地 HTML，请' + hint;
    }
    if (url) return '请确认打开的是本地 HTML 网页，然后刷新页面。';
  }
  return '请刷新网页后重试。Chrome 内部页面无法翻译。';
}
