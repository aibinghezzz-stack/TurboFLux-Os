import './styles.css'
import { mountWorkbench } from './workbench'
import { initializeTheme } from './theme'

const app = document.querySelector<HTMLDivElement>('#app')!

initializeTheme()
mountWorkbench(app)
