import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PortalModal } from "./PortalModal";

it("contains keyboard focus and restores the opening control", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const { unmount } = render(<PortalModal title="测试弹窗" onClose={vi.fn()}><input aria-label="内容" /><button>末项</button></PortalModal>);
  expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
  screen.getByRole("button", { name: "末项" }).focus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(screen.getByRole("button", { name: "末项" })).toHaveFocus();
  unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});
