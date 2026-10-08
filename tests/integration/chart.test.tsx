import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { TrendChart } from '../../src/components/TrendChart';

it('欠損を線でつながず、空の履歴には説明を表示する', () => {
  const at = (seconds: number) => new Date(Date.parse('2026-10-08T12:00:00Z') + seconds * 1000).toISOString();
  const { rerender } = render(<TrendChart label="CPU" points={[
    { at: at(0), value: 10 }, { at: at(15), value: 20 }, { at: at(30), value: null },
    { at: at(45), value: 30 }, { at: at(60), value: 40 },
    { at: at(120), value: 50 }, { at: at(135), value: 60 },
  ]} />);
  expect(screen.getAllByTestId('trend-segment')).toHaveLength(3);
  rerender(<TrendChart label="CPU" points={[]} />);
  expect(screen.queryByTestId('trend-segment')).not.toBeInTheDocument();
  expect(screen.getByRole('img')).toHaveAccessibleName(/履歴を取得できません/);
});
