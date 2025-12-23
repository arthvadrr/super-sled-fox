import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Enable editor in development mode only. This is replaced at compile-time
  // so editor code can be eliminated from production bundles.
  const editorEnabled = mode === 'development';

  return {
    plugins: [react()],
    define: {
      EDITOR_ENABLED: JSON.stringify(editorEnabled),
    },
  };
});
