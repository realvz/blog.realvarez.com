document.addEventListener('DOMContentLoaded', (event) => {
    init_mode();
    convertAltTextToCaptions();
});

function convertAltTextToCaptions() {
    const images = document.querySelectorAll('img');
    images.forEach(img => {
        if (img.alt && img.alt.trim() !== '') {
            const figure = document.createElement('figure');
            const figcaption = document.createElement('figcaption');
            
            figcaption.textContent = img.alt;
            img.parentNode.insertBefore(figure, img);
            figure.appendChild(img);
            figure.appendChild(figcaption);
        }
    });
}

function updateGiscusTheme() {
    const theme = localStorage.theme === 'dark' ? 'dark' : 'light';
    const iframe = document.querySelector('iframe.giscus-frame');
    if (iframe) {
        iframe.contentWindow.postMessage(
            { giscus: { setConfig: { theme: theme } } },
            'https://giscus.app'
        );
    }
}

function init_mode() {
    const darkmodeCheckbox = document.getElementById("darkmode");
    const htmlElement = document.documentElement;

    if (localStorage.theme === 'dark') {
        darkmodeCheckbox.checked = true;
        htmlElement.classList.add('dark');
    } else {
        darkmodeCheckbox.checked = false;
        htmlElement.classList.remove('dark');
    }
    updateGiscusTheme();
}

function change_mode() {
    const darkmodeCheckbox = document.getElementById("darkmode");
    const htmlElement = document.documentElement;

    if (darkmodeCheckbox.checked) {
        localStorage.theme = 'dark';
        htmlElement.classList.add('dark');
    } else {
        localStorage.theme = 'light';
        htmlElement.classList.remove('dark');
    }
    updateGiscusTheme();
}
