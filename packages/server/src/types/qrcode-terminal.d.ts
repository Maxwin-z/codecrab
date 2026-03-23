declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean
  }
  function generate(text: string, opts?: Options, cb?: (qr: string) => void): void
  function setErrorLevel(level: string): void
  export default { generate, setErrorLevel }
}
