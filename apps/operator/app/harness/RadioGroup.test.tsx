// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RadioGroup } from "./RadioGroup";

afterEach(cleanup);

const OPTIONS = [
  { value: "snapshot", label: "Snapshot" },
  { value: "backup", label: "Backup" },
  { value: "discard", label: "Discard" },
] as const;

function Harness({
  initial = "snapshot",
  options = OPTIONS,
  onChange,
}: {
  initial?: string | null;
  options?: readonly { value: string; label: string; disabled?: boolean }[];
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <RadioGroup
      label="Recoverability disposition"
      value={value}
      options={options}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    >
      {(option) => <span>{option.label}</span>}
    </RadioGroup>
  );
}

const radios = () => screen.getAllByRole("radio") as HTMLButtonElement[];

describe("RadioGroup", () => {
  it("names the group and marks exactly one option checked", () => {
    render(<Harness />);

    expect(
      screen.getByRole("radiogroup", { name: "Recoverability disposition" }),
    ).toBeTruthy();
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("keeps exactly one tab stop, on the selected option", () => {
    render(<Harness initial="backup" />);
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("puts the tab stop on the first option when nothing is selected yet", () => {
    /* Otherwise an unselected group is unreachable by keyboard entirely. */
    render(<Harness initial={null} />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(radios().every((r) => r.getAttribute("aria-checked") === "false")).toBe(
      true,
    );
  });

  it("moves selection and focus together with the arrow keys, wrapping both ways", () => {
    render(<Harness />);

    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios()[1]);
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");

    /* Wrap forward off the end… */
    fireEvent.keyDown(radios()[1], { key: "End" });
    fireEvent.keyDown(radios()[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios()[0]);
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");

    /* …and backward off the start. */
    fireEvent.keyDown(radios()[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(radios()[2]);
    expect(radios()[2].getAttribute("aria-checked")).toBe("true");
  });

  it("treats horizontal arrows as equivalent to vertical ones", () => {
    render(<Harness />);

    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: "ArrowRight" });
    expect(radios()[1].getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(radios()[1], { key: "ArrowLeft" });
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
  });

  it("jumps to the ends with Home and End", () => {
    render(<Harness initial="backup" />);

    radios()[1].focus();
    fireEvent.keyDown(radios()[1], { key: "End" });
    expect(document.activeElement).toBe(radios()[2]);
    expect(radios()[2].getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(radios()[2], { key: "Home" });
    expect(document.activeElement).toBe(radios()[0]);
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
  });

  it("ignores keys it does not own, without preventing their default", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: "Tab" });
    fireEvent.keyDown(radios()[0], { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
  });

  it("selects on click and reports the value once", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(radios()[2]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("discard");
    expect(radios()[2].getAttribute("aria-checked")).toBe("true");
  });

  it("renders a disabled option as unselectable", () => {
    const onChange = vi.fn();
    render(
      <Harness
        options={[
          { value: "snapshot", label: "Snapshot" },
          { value: "backup", label: "Backup", disabled: true },
        ]}
        onChange={onChange}
      />,
    );

    const [, backup] = radios();
    expect(backup.disabled).toBe(true);
    fireEvent.click(backup);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses no native radio input, which the design-primitive lint forbids", () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(container.querySelectorAll('button[role="radio"]')).toHaveLength(3);
  });

  it("skips disabled options with arrows and wraps among enabled options", () => {
    const onChange = vi.fn();
    render(<Harness options={OPTIONS.map((option) => ({ ...option, disabled: option.value === "backup" }))} onChange={onChange} />);
    radios()[0].focus();
    fireEvent.keyDown(radios()[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("discard");
    expect(document.activeElement).toBe(radios()[2]);
    fireEvent.keyDown(radios()[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(radios()[0]);
    fireEvent.keyDown(radios()[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios()[2]);
    fireEvent.keyDown(radios()[2], { key: "ArrowUp" });
    expect(document.activeElement).toBe(radios()[0]);
    expect(onChange.mock.calls.flat()).not.toContain("backup");
  });

  it("uses the first enabled tab stop and skips disabled ends with Home and End", () => {
    render(<Harness initial="snapshot" options={[
      { value: "snapshot", label: "Snapshot", disabled: true },
      { value: "backup", label: "Backup" },
      { value: "discard", label: "Discard" },
      { value: "unavailable", label: "Unavailable", disabled: true },
    ]} />);
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0, -1, -1]);
    radios()[1].focus();
    fireEvent.keyDown(radios()[1], { key: "End" });
    expect(document.activeElement).toBe(radios()[2]);
    fireEvent.keyDown(radios()[2], { key: "Home" });
    expect(document.activeElement).toBe(radios()[1]);
  });

  it("has no tab stop or keyboard selection when every option is disabled", () => {
    const onChange = vi.fn();
    render(<Harness options={OPTIONS.map((option) => ({ ...option, disabled: true }))} onChange={onChange} />);
    expect(radios().every((radio) => radio.tabIndex === -1)).toBe(true);
    fireEvent.keyDown(radios()[0], { key: "ArrowRight" });
    fireEvent.keyDown(radios()[0], { key: "End" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("records a click on the selected option as an explicit answer", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(radios()[0]);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("snapshot");
  });
});
