import { describe, it, expect } from 'vitest';
import { pad_folder_column } from '@/services/shared/progress-display-format';

describe('pad_folder_column', () => {
  it('pads short names with spaces', () => {
    expect(pad_folder_column('Inbox', 10)).toBe('Inbox     ');
  });

  it('truncates long names with tilde', () => {
    const long = 'a'.repeat(40);
    expect(pad_folder_column(long, 10)).toBe('aaaaaaaaa~');
    expect(pad_folder_column(long, 10).length).toBe(10);
  });
});
