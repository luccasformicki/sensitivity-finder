import React from 'react';
import ReactDOM from 'react-dom/client';
import SensitivityFinder from './SensitivityFinder.jsx';
import './index.css';

// StrictMode fica desligado aqui de propósito: ele duplica o ciclo de
// montagem em dev, o que atrapalharia o teste manual do Pointer Lock.
ReactDOM.createRoot(document.getElementById('root')).render(<SensitivityFinder />);
