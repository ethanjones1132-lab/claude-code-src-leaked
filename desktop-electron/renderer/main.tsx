import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Jarvis root element was not found.')
}

createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
