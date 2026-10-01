// Browser tab title: "(2) Today · Engineering Board". The unread count shows
// even when the board is in a background tab.
let page = '';
let unread = 0;
function update() {
  document.title = `${unread > 0 ? `(${unread}) ` : ''}${page ? `${page} – ` : ''}Engineering Board`;
}
export function setPageTitle(p: string) {
  page = p;
  update();
}
export function setUnreadCount(n: number) {
  unread = n;
  update();
}
