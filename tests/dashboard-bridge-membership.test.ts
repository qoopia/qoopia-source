// A waiting join can be withdrawn by the joiner and declined by the creator (F-520-bridge-pending-leave).
import { expect, test } from "bun:test";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/public/brand/dashboard.js", import.meta.url), "utf8");

test("a pending bridge offers Withdraw request, sent as the leave operation", () => {
  expect(source).toContain(`g?.state==='pending'?'<div class="work-actions"><button id="bridgeWithdraw">'`);
  expect(source).toMatch(/bridgeWithdrawConfirm'\)\.onclick=async\(\)=>\{try\{await act\('membership',\{group:g\.id,operation:'leave'\}\)/);
});

test("the creator can decline a waiting member instead of only admitting", () => {
  expect(source).toContain(`'<button id="bridgeMemberDecline">'+QI.msg("Decline request")`);
  expect(source).toContain(`$('#bridgeMemberDecline').onclick=decide('remove')`);
});
