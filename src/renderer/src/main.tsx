import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// A file dropped outside a drop zone must never navigate the app to file:///…
// (Chromium's default). Terminal drop zones still work — their own listeners run
// first during bubbling; this only suppresses the default navigation.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
