// Convert build/icon.png -> build/icon.ico (multi-size) for electron-builder.
const fs = require('fs')
const path = require('path')
const mod = require('png-to-ico')
const pngToIco = mod.default || mod

const src = path.join(__dirname, 'icon.png')
pngToIco(src)
  .then((buf) => {
    fs.writeFileSync(path.join(__dirname, 'icon.ico'), buf)
    console.log('wrote build/icon.ico (' + buf.length + ' bytes)')
  })
  .catch((e) => {
    console.error('icon build failed:', e)
    process.exit(1)
  })
