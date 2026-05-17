import { mount } from 'svelte';

import App from './App.svelte';
import './styles/base.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app mount target');

mount(App, { target });
