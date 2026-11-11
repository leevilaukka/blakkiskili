// TV and Chromecast browsers run old Chromium. Svelte's runtime calls String.prototype.replaceAll
// (Chrome 85+), which would throw while rendering the cast receiver page.
if (!String.prototype.replaceAll) {
  String.prototype.replaceAll = function (this: string, search: string | RegExp, replacement: any): string {
    if (search instanceof RegExp) {
      if (!search.global) throw new TypeError("replaceAll must be called with a global RegExp");
      return this.replace(search, replacement);
    }
    return this.split(String(search)).join(typeof replacement === "string" ? replacement : String(replacement));
  } as any;
}
