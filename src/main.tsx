import './index.css'

/* For its side effect: installs the mailbox before React mounts, so a host's
   greeting that arrives early is held rather than lost. */
import 'kehikot-module-protocol/client'
import { mountPage } from 'kehikot-module-protocol/client/mount'
import { App } from './app.tsx'

mountPage('root', <App />)
