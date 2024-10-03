<script>
document.addEventListener('DOMContentLoaded', function() {
    const dropArea = document.getElementById('drop-area');
    const videoPlayer = document.getElementById('videoPlayer');
    const videoSource = document.getElementById('videoSource');
    const vrRoot = document.getElementById('vr-root');
    const closeButton = document.querySelector('.close-btn');
    const vrVideo = document.getElementById('vr-video');
    let vrSrc = ''; // 存储VR视频源

    // 处理拖拽进入事件
    dropArea.addEventListener('dragover', function(e) {
        e.preventDefault();
        dropArea.classList.add('dragover');
    });

    // 处理拖拽离开事件
    dropArea.addEventListener('dragleave', function(e) {
        e.preventDefault();
        dropArea.classList.remove('dragover');
    });

    // 处理文件放下（drop）事件
    dropArea.addEventListener('drop', function(e) {
        e.preventDefault();
        dropArea.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFiles(files);
        }
    });

    // 处理文件选择
    function handleFiles(files) {
        const file = files[0];
        if (file.type.startsWith('video/')) {
            const src = URL.createObjectURL(file);
            videoSource.setAttribute('src', src);
            videoPlayer.load();
            videoPlayer.play();
            vrSrc = src; // 保存VR视频源
        } else {
            alert('Please upload a valid video file.');
        }
    }

    // 打开VR视图
    function openVr() {
        if (vrSrc) {
            vrVideo.setAttribute('src', vrSrc);
            vrRoot.style.display = 'flex';
            vrVideo.play();
        }
    }

    // 关闭VR视图
    function closeVr() {
        vrRoot.style.display = 'none';
        vrVideo.pause();
        vrVideo.setAttribute('src', '');
    }

    closeButton.addEventListener('click', closeVr);

    // 监听视频播放元素的点击事件，打开VR视图
    videoPlayer.addEventListener('click', function() {
        openVr();
    });
});
</script>
