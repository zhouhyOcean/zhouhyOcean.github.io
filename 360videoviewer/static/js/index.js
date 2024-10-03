<script>
document.addEventListener('DOMContentLoaded', function() {
    const dropArea = document.getElementById('drop-area');
    const videoContainer = document.getElementById('video-container');
    const video = document.getElementById('vr-video');
    const closeButton = document.getElementsByClassName('close-btn')[0];

    // 处理拖拽事件
    dropArea.addEventListener('dragover', function(e) {
        e.preventDefault();
        dropArea.classList.add('dragover');
    });

    dropArea.addEventListener('dragleave', function(e) {
        e.preventDefault();
        dropArea.classList.remove('dragover');
    });

    dropArea.addEventListener('drop', function(e) {
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
                video.src = src;
                openVideo();
            } else {
                alert('Please upload a valid video file.');
            }
        }
    }

    function openVideo() {
        videoContainer.style.display = 'flex';
    }

    closeButton.addEventListener('click', function() {
        videoContainer.style.display = 'none';
        video.src = ''; // Clear the video source
        URL.revokeObjectURL(video.src); // Release the object URL
    });
});
</script>
