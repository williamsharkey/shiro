/// <reference types="vite/client" />

declare module '*?raw' {
  const content: string;
  export default content;
}

/** The git commit the page was built from ('' when unknown); vite.config.ts */
declare const __BUILD_SHA__: string;
