// Rendering tests for ReturnLink (vitest + Testing Library + jsdom). Vendored with the component: a copy keeps passing them.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ReturnLink from "./ReturnLink.jsx";

afterEach(cleanup);
const at = (search, pathname = "/some-app/") => ({ hostname: "labs.example", pathname, search });

describe("ReturnLink", () => {
  it("renders nothing without a known from", () => {
    const { container } = render(<ReturnLink app="some-app" location={at("?from=elsewhere&uc=UC1")} />);
    expect(container.innerHTML).toBe("");
    const { container: c2 } = render(<ReturnLink app="some-app" location={at("")} />);
    expect(c2.innerHTML).toBe("");
  });

  it("renders nothing for a bad id", () => {
    const { container } = render(<ReturnLink app="some-app" location={at("?from=customer-agent&uc=%3Cimg%3E")} />);
    expect(container.innerHTML).toBe("");
  });

  it("strip: names the app and the use case, Back navigates the same tab to the fixed proxy path", () => {
    const navigate = vi.fn();
    render(<ReturnLink app="some-app" navigate={navigate} location={at("?from=customer-agent&uc=UC47&vertical=banking")} />);
    const note = screen.getByRole("note", { name: "Opened from Customer Agent LAB" });
    expect(note.textContent).toContain("UC47");
    expect(note.textContent).toContain("banking");
    fireEvent.click(screen.getByRole("button", { name: /Back to Customer Agent LAB/ }));
    expect(navigate).toHaveBeenCalledWith("/customer-agent/?returned=some-app&uc=UC47");
  });

  it("header variant: a compact button, direct URL when the app is served at its root", () => {
    const navigate = vi.fn();
    render(<ReturnLink app="some-app" variant="header" navigate={navigate} location={at("?from=customer-agent&uc=UC47", "/")} />);
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Back to Customer Agent LAB/ }));
    expect(navigate).toHaveBeenCalledWith("http://127.0.0.1:5603/?returned=some-app&uc=UC47");
  });

  it("an open-redirect attempt still goes only to the fixed target", () => {
    const navigate = vi.fn();
    render(<ReturnLink app="some-app" navigate={navigate} location={at("?from=customer-agent&uc=UC1&next=https://evil.example/")} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to/ }));
    expect(navigate).toHaveBeenCalledWith("/customer-agent/?returned=some-app&uc=UC1");
  });
});
