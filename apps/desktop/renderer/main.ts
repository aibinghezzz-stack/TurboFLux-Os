import './styles.css'
import { mountWorkbench } from './workbench'

const app = document.querySelector<HTMLDivElement>('#app')!

mountWorkbench(app)
