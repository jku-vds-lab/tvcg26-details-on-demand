import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react';
import LabeledSlider from './LabeledSlider';

const baseConfig = {
  min: 0,
  max: 20,
  step: 1,
  marks: [
    { value: 0, label: '0' },
    { value: 20, label: '20' },
  ],
} as const;

// Helper to grab the MUI Slider thumb at the given data-index within a container.
function getThumb(container: HTMLElement, index = 0): HTMLElement {
  const thumb = container.querySelector(`[data-index="${index}"]`) as HTMLElement | null;
  if (!thumb) throw new Error(`No thumb found at data-index="${index}"`);
  return thumb;
}

// ─── Single-value slider ──────────────────────────────────────────────────────

describe('LabeledSlider – double-click reset (single thumb)', () => {
  it('calls onChange with the defaultValue when the thumb is double-clicked', () => {
    const onChange = jest.fn();
    const { container } = render(
      <LabeledSlider
        label="Test"
        value={15}
        onChange={onChange}
        config={baseConfig}
        defaultValue={5}
      />,
    );

    fireEvent.dblClick(getThumb(container));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.any(MouseEvent), 5);
  });

  it('does NOT call onChange on double-click when defaultValue is omitted', () => {
    const onChange = jest.fn();
    const { container } = render(
      <LabeledSlider
        label="Test"
        value={15}
        onChange={onChange}
        config={baseConfig}
      />,
    );

    fireEvent.dblClick(getThumb(container));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('does NOT call onChange when double-clicking the track (not a thumb)', () => {
    const onChange = jest.fn();
    const { container } = render(
      <LabeledSlider
        label="Test"
        value={15}
        onChange={onChange}
        config={baseConfig}
        defaultValue={5}
      />,
    );

    // Click on the Box wrapper itself (no data-index ancestor).
    const box = container.firstChild as HTMLElement;
    fireEvent.dblClick(box);

    expect(onChange).not.toHaveBeenCalled();
  });
});

// ─── Range slider ─────────────────────────────────────────────────────────────

const rangeConfig = {
  min: 0,
  max: 1,
  step: 0.01,
  marks: [
    { value: 0, label: '0' },
    { value: 1, label: '1' },
  ],
} as const;

// ─── Value formatting + tooltip (issue #261) ─────────────────────────────────

describe('LabeledSlider – valueLabelFormat and tooltip', () => {
  it('applies valueLabelFormat to the thumb value label', () => {
    const { container } = render(
      <LabeledSlider
        label="Fmt"
        value={0}
        onChange={jest.fn()}
        config={baseConfig}
        valueLabelDisplay="on"
        valueLabelFormat={(v) => (v === 0 ? 'off' : `${v}`)}
      />,
    );

    expect(container.textContent).toContain('off');
  });

  it('strips floating-point dust from the value label by default', () => {
    const { container } = render(
      <LabeledSlider
        label="Dust"
        value={30 * 0.01} // 0.30000000000000004 — as accumulated by keyboard stepping
        onChange={jest.fn()}
        config={rangeConfig}
        valueLabelDisplay="on"
      />,
    );

    expect(container.textContent).toContain('0.3');
    expect(container.textContent).not.toContain('0.30000');
  });

  it('renders an info icon when tooltip is provided', () => {
    const { container } = render(
      <LabeledSlider
        label="Tip"
        value={5}
        onChange={jest.fn()}
        config={baseConfig}
        tooltip="Explains the slider"
      />,
    );

    expect(container.querySelector('svg[data-testid="InfoOutlinedIcon"]')).not.toBeNull();
  });

  it('renders no info icon without a tooltip', () => {
    const { container } = render(
      <LabeledSlider label="NoTip" value={5} onChange={jest.fn()} config={baseConfig} />,
    );

    expect(container.querySelector('svg[data-testid="InfoOutlinedIcon"]')).toBeNull();
  });
});

// ─── Inline unfold arrow (issue #261 part 4) ─────────────────────────────────

describe('LabeledSlider – unfold', () => {
  it('renders no arrow without an unfold', () => {
    const { queryByLabelText } = render(
      <LabeledSlider label="Plain" value={5} onChange={jest.fn()} config={baseConfig} />,
    );

    expect(queryByLabelText('Plain details')).toBeNull();
  });

  it('toggles the unfolded content through the arrow, collapsed by default', () => {
    const { getByLabelText } = render(
      <LabeledSlider
        label="Main"
        value={5}
        onChange={jest.fn()}
        config={baseConfig}
        unfold={<div>sub-controls</div>}
      />,
    );

    const arrow = getByLabelText('Main details');
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(arrow);
    expect(arrow.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(arrow);
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
  });

  it("does not reset this slider when a nested slider's thumb is double-clicked", () => {
    const onChangeOuter = jest.fn();
    const { getByLabelText, container } = render(
      <LabeledSlider
        label="Outer"
        value={15}
        onChange={onChangeOuter}
        config={baseConfig}
        defaultValue={5}
        unfold={
          <LabeledSlider
            label="Inner"
            value={10}
            onChange={jest.fn()}
            config={baseConfig}
            defaultValue={0}
          />
        }
      />,
    );

    fireEvent.click(getByLabelText('Outer details'));
    // Two single-thumb sliders → two thumbs; the second is the inner's.
    const thumbs = container.querySelectorAll('.MuiSlider-thumb');
    expect(thumbs.length).toBe(2);
    fireEvent.dblClick(thumbs[1]);

    expect(onChangeOuter).not.toHaveBeenCalled();
  });
});

describe('LabeledSlider – double-click reset (range slider)', () => {
  it('resets only the first thumb while preserving the second', () => {
    const onChange = jest.fn();
    const { container } = render(
      <LabeledSlider
        label="Range"
        value={[0.3, 0.8]}
        onChange={onChange}
        config={rangeConfig}
        defaultValue={[0, 1]}
        disableSwap
      />,
    );

    fireEvent.dblClick(getThumb(container, 0));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.any(MouseEvent), [0, 0.8]);
  });

  it('resets only the second thumb while preserving the first', () => {
    const onChange = jest.fn();
    const { container } = render(
      <LabeledSlider
        label="Range"
        value={[0.3, 0.8]}
        onChange={onChange}
        config={rangeConfig}
        defaultValue={[0, 1]}
        disableSwap
      />,
    );

    fireEvent.dblClick(getThumb(container, 1));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(expect.any(MouseEvent), [0.3, 1]);
  });
});
