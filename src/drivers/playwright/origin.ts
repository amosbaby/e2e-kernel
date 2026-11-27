// 「请求是同源的」的判定（纯函数，不碰浏览器）。同源的放行写才由内核代发（route.fetch，不跟重定向）；跨源的照常 continue，
// 由浏览器自己发，SameSite cookie 和 CORS 照浏览器的规矩。判断不出一律按跨源算（失败关闭的方向：不替浏览器多带 cookie、多补 CORS 头）。
//
// 两个条件都要成立：
// 1. 发出请求的 frame 的地址和目标同源（http(s)）；
// 2. 请求带 Origin 头时，它必须等于目标的 origin。沙箱 iframe（sandbox 不带 allow-same-origin）的 frame 地址和宿主同源，
//    但文档的 origin 是 null，浏览器按跨源处理，请求带 `Origin: null`；`null`、空串、别的 origin、解析不了都不算同源。
//    没有 Origin 头：同源的 GET 之类浏览器本来就不带，按 frame 地址判（POST 等跨源请求浏览器一定带）。
export function isSameOriginRequest(frameUrl: string, targetUrl: string, originHeader: string | undefined): boolean {
  try {
    const from = new URL(frameUrl);
    const to = new URL(targetUrl);
    if (from.origin === 'null' || from.origin !== to.origin) return false;
    if (originHeader === undefined) return true;
    return originHeader === to.origin;
  } catch {
    return false;
  }
}
