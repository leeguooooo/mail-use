import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { _htmlToText } = require("../src/services/email/body.js");

describe("_htmlToText drops text hidden from the reader", () => {
  it("drops display:none and visibility:hidden elements", () => {
    expect(_htmlToText('<p>Hi</p><div style="display:none">secret</div><p>Thanks</p>')).toBe("Hi\nThanks");
    expect(_htmlToText('<p style="color:red; Visibility: hidden">secret</p><p>shown</p>')).toBe("shown");
    expect(_htmlToText('<span style="display: none !important">secret</span>shown')).toBe("shown");
  });

  it("drops elements with the hidden attribute, not hidden-looking values", () => {
    expect(_htmlToText('<span hidden>secret</span>ok <input type="hidden" value="x"> <p title="hidden gem">gem</p>')).toBe("ok gem");
  });

  it("drops nested content up to the matching close tag", () => {
    expect(_htmlToText('<div style="display:none"><div>a</div><div>secret</div></div><p>after</p>')).toBe("after");
  });

  it("an unclosed hidden element hides the rest of the document (fails closed)", () => {
    expect(_htmlToText('<p>keep</p><div style="display:none">secret <p>more</p>')).toBe("keep");
  });

  it("leaves visible and look-alike styles alone", () => {
    expect(_htmlToText('<div style="display:block">shown</div>')).toBe("shown");
    expect(_htmlToText('<td style="mso-display:none">outlook</td>')).toBe("outlook");
  });
});
