import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import MembershipGate from './MembershipGate'
import './styles.css'
import './membership.css'
import './edge-theme.css'
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><MembershipGate><App /></MembershipGate></React.StrictMode>)
