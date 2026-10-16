import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Dọn DOM và mock sau mỗi test
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});
