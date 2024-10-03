document.addEventListener('DOMContentLoaded', function() {
    const dropArea = document.getElementById('drop-area');
    const vrRoot = document.getElementById('vr-root');

    // 处理拖拽事件
    dropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropArea.classList.add('dragover');
    });

    dropArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropArea.classList.remove('dragover');
    });

    dropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        dropArea.classList.remove('dragover');
        const files = e.dataTransfer.files;
        handleFiles(files);
    });

    function handleFiles(files) {
        if (files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('video/')) {
                const src = URL.createObjectURL(file);
                openVr(src);
            } else {
                alert('Please upload a valid VR video file.');
            }
        }
    }

    function openVr(src) {
        vrRoot.innerHTML = `
            <div class="vr-container">
                <a-scene vr-mode-ui="enabled: false" embedded>
                    <a-assets>
                        <video id="vr-video" loop playsinline muted autoplay src="${src}"></video>
                    </a-assets>
                    <a-videosphere src="#vr-video"></a-videosphere>
                </a-scene>
            </div>
        `;
        vrRoot.style.display = 'block';

        const closeBtn = document.createElement("div");
        closeBtn.ariaLabel = "close-vr";
        closeBtn.classList.add("close-btn");
        closeBtn.innerHTML = `
            <svg t="1707812514995" class="icon" viewBox="0 0 1025 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="40" height="40">
                <path d="M513.344 0a512 512 0 1 0 0 1024 512 512 0 0 0 0-1024z m226.048 674.624l-54.528 56.896-171.52-164.928-171.392 164.928-54.592-56.896L456.576 512 287.36 349.312l54.592-56.768 171.392 164.8 171.52-164.8 54.528 56.768L570.176 512l169.216 162.624z" fill="#ffffff"></path>
            </svg>
        `;
        closeBtn.addEventListener("click", closeVr);
        vrRoot.append(closeBtn);
    }

    function closeVr() {
        vrRoot.style.display = 'none';
        vrRoot.innerHTML = '';
    }
});
