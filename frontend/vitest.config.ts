import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Test giao diện: jsdom, không nạp Tailwind (không cần CSS để kiểm tra hành vi)
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
  },
});
