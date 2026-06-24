// electron-vite ?asset imports (e.g. the window icon)
declare module '*?asset' {
  const src: string
  export default src
}
