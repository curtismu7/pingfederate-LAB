// Customer Agent LAB hands a use case here with ?from=customer-agent&uc=<id>&vertical=<id> (read by the vendored return-link module).
// Preselect only where the catalog id obviously maps to one of this lab's own cards or verticals; anything else opens the shelf (strip only).
// UC-LEARN12 (DaVinci integration kit) also routes here but has no card, so it gets the strip only.
export const UC_CARD = Object.freeze({ "UC-LOGIN-PF": "signin", "UC-LEARN13": "rar" });
export const VERTICALS = Object.freeze(["banking", "healthcare", "retail"]); // the same ids as server/src/customer.js
export const cardFor = (ctx) => (ctx && Object.hasOwn(UC_CARD, ctx.uc) ? UC_CARD[ctx.uc] : null);
export const verticalFor = (ctx) => (ctx && ctx.vertical && VERTICALS.includes(ctx.vertical) ? ctx.vertical : null);
