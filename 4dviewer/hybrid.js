import * as SPLAT from "https://cdn.jsdelivr.net/npm/gsplat@latest";

const startRadius = 0.1
let radius = 0.1
let lastRadius = 0.1
let radiusSignChanged = 1.0
let alpha = 0.0
let beta = 0.0
const minAngle = -20
const maxAngle = 20
const minZoom = -1.5
const maxZoom = 1.5
const zoomSpeed = 0.03
const panSpeed = 0.2
const orbitSpeed = 1.75
const maxPanDistance = 0.05
const dampening = 0.12
const cameraData = new SPLAT.CameraData();
//let cameras = [new SPLAT.Camera(cameraData)];
let cameras = [
  {
    id: 0,
    img_name: "00001",
    width: 2560,
    height: 1920,
    position: {x: 0, y: 0, z: -0.1},
    rotation: {x: 0, y: 0, z: 0, w: 1},
    fy: 668.155076089281,
    fx: 668.155076089281,
  },
];
const Matrix3 = SPLAT.Matrix3;
const Quaternion = SPLAT.Quaternion;
const Vector3 = SPLAT.Vector3;

let camera = cameras[0];


function createWorker(self) {
  let vertexCount = 0;
  let viewProj;
  let lastProj = [];
  let depthIndex = new Uint32Array();
  let lastVertexCount = 0;
  let positions;

  var _floatView = new Float32Array(1);
  var _int32View = new Int32Array(_floatView.buffer);

  function floatToHalf(float) {
    _floatView[0] = float;
    var f = _int32View[0];
    var sign = (f >> 31) & 0x0001;
    var exp = (f >> 23) & 0x00ff;
    var frac = f & 0x007fffff;
    var newExp;
    if (exp == 0) {
      newExp = 0;
    } else if (exp < 113) {
      newExp = 0;
      frac |= 0x00800000;
      frac = frac >> (113 - exp);
      if (frac & 0x01000000) {
        newExp = 1;
        frac = 0;
      }
    } else if (exp < 142) {
      newExp = exp - 112;
    } else {
      newExp = 31;
      frac = 0;
    }
    return (sign << 15) | (newExp << 10) | (frac >> 13);
  }

  function packHalf2x16(x, y) {
    return (floatToHalf(x) | (floatToHalf(y) << 16)) >>> 0;
  }

  function runSort(viewProj) {
    if (!positions) return;
    // const f_buffer = new Float32Array(buffer);
    if (lastVertexCount == vertexCount) {
      let dist = Math.hypot(...[2, 6, 10].map((k) => lastProj[k] - viewProj[k]));
      if (dist < 0.01) return;
    } else {
      lastVertexCount = vertexCount;
    }

    console.time("sort");
    let maxDepth = -Infinity;
    let minDepth = Infinity;
    let sizeList = new Int32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      let depth =
        ((viewProj[2] * positions[3 * i + 0] + viewProj[6] * positions[3 * i + 1] + viewProj[10] * positions[3 * i + 2]) * 4096) | 0;
      sizeList[i] = depth;
      if (depth > maxDepth) maxDepth = depth;
      if (depth < minDepth) minDepth = depth;
    }

    // This is a 16 bit single-pass counting sort
    let depthInv = (256 * 256) / (maxDepth - minDepth);
    let counts0 = new Uint32Array(256 * 256);
    for (let i = 0; i < vertexCount; i++) {
      sizeList[i] = ((sizeList[i] - minDepth) * depthInv) | 0;
      counts0[sizeList[i]]++;
    }
    let starts0 = new Uint32Array(256 * 256);
    for (let i = 1; i < 256 * 256; i++) starts0[i] = starts0[i - 1] + counts0[i - 1];
    depthIndex = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) depthIndex[starts0[sizeList[i]]++] = i;

    console.timeEnd("sort");

    lastProj = viewProj;
    self.postMessage({ depthIndex, viewProj, vertexCount }, [depthIndex.buffer]);
  }


  const throttledSort = () => {
    if (!sortRunning) {
      sortRunning = true;
      let lastView = viewProj;
      runSort(lastView);
      setTimeout(() => {
        sortRunning = false;
        if (lastView !== viewProj) {
          throttledSort();
        }
      }, 0);
    }
  };

  let sortRunning;

  function processPlyBuffer(inputBuffer) {
    const ubuf = new Uint8Array(inputBuffer);
    // 10KB ought to be enough for a header...
    const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
    const header_end = "end_header\n";
    const header_end_index = header.indexOf(header_end);
    if (header_end_index < 0) throw new Error("Unable to read .ply file header");
    const vertexCount = parseInt(/element vertex (\d+)\n/.exec(header)[1]);
    console.log("Vertex Count", vertexCount);
    let row_offset = 0,
      offsets = {},
      types = {};
    const TYPE_MAP = {
      double: "getFloat64",
      int: "getInt32",
      uint: "getUint32",
      float: "getFloat32",
      short: "getInt16",
      ushort: "getUint16",
      uchar: "getUint8",
    };
    for (let prop of header
      .slice(0, header_end_index)
      .split("\n")
      .filter((k) => k.startsWith("property "))) {
      const [p, type, name] = prop.split(" ");
      const arrayType = TYPE_MAP[type] || "getInt8";
      types[name] = arrayType;
      offsets[name] = row_offset;
      row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
    }

    console.log("Bytes per row", row_offset, types, offsets);

    let dataView = new DataView(inputBuffer, header_end_index + header_end.length);
    let row = 0;
    const attrs = new Proxy(
      {},
      {
        get(target, prop) {
          if (!types[prop]) throw new Error(prop + " not found");
          return dataView[types[prop]](row * row_offset + offsets[prop], true);
        },
      }
    );

    console.time("calculate importance");
    let sizeList = new Float32Array(vertexCount);
    let sizeIndex = new Uint32Array(vertexCount);
    for (row = 0; row < vertexCount; row++) {
      sizeIndex[row] = row;
      if (!types["scale_0"]) continue;
      const size = Math.exp(attrs.scale_0) * Math.exp(attrs.scale_1) * Math.exp(attrs.scale_2);
      const opacity = 1 / (1 + Math.exp(-attrs.opacity));
      sizeList[row] = size * opacity;
    }
    console.timeEnd("calculate importance");

    for (let type in types) {
      let min = Infinity,
        max = -Infinity;
      for (row = 0; row < vertexCount; row++) {
        sizeIndex[row] = row;
        min = Math.min(min, attrs[type]);
        max = Math.max(max, attrs[type]);
      }
      console.log(type, min, max);
    }

    console.time("sort");
    sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);
    console.timeEnd("sort");

    const position_buffer = new Float32Array(3 * vertexCount);

    var texwidth = 1024 * 4; // Set to your desired width
    var texheight = Math.ceil((4 * vertexCount) / texwidth); // Set to your desired height
    var texdata = new Uint32Array(texwidth * texheight * 4); // 4 components per pixel (RGBA)
    var texdata_c = new Uint8Array(texdata.buffer);
    var texdata_f = new Float32Array(texdata.buffer);

    console.time("build buffer");
    for (let j = 0; j < vertexCount; j++) {
      row = sizeIndex[j];

      // x, y, z
      position_buffer[3 * j + 0] = attrs.x;
      position_buffer[3 * j + 1] = attrs.y;
      position_buffer[3 * j + 2] = attrs.z;

      texdata_f[16 * j + 0] = attrs.x;
      texdata_f[16 * j + 1] = attrs.y;
      texdata_f[16 * j + 2] = attrs.z;

      // quaternions
      texdata[16 * j + 3] = packHalf2x16(attrs.rot_0, attrs.rot_1);
      texdata[16 * j + 4] = packHalf2x16(attrs.rot_2, attrs.rot_3);

      // scale
      texdata[16 * j + 5] = packHalf2x16(Math.exp(attrs.scale_0), Math.exp(attrs.scale_1));
      texdata[16 * j + 6] = packHalf2x16(Math.exp(attrs.scale_2), 0);

      // rgb
      texdata_c[4 * (16 * j + 7) + 0] = Math.max(0, Math.min(255, attrs.f_dc_0 * 255));
      texdata_c[4 * (16 * j + 7) + 1] = Math.max(0, Math.min(255, attrs.f_dc_1 * 255));
      texdata_c[4 * (16 * j + 7) + 2] = Math.max(0, Math.min(255, attrs.f_dc_2 * 255));

      // opacity
      texdata_c[4 * (16 * j + 7) + 3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;

      // movement over time
      texdata[16 * j + 8 + 0] = packHalf2x16(attrs.motion_0, attrs.motion_1);
      texdata[16 * j + 8 + 1] = packHalf2x16(attrs.motion_2, attrs.motion_3);
      texdata[16 * j + 8 + 2] = packHalf2x16(attrs.motion_4, attrs.motion_5);
      texdata[16 * j + 8 + 3] = packHalf2x16(attrs.motion_6, attrs.motion_7);
      texdata[16 * j + 8 + 4] = packHalf2x16(attrs.motion_8, 0);

      // rotation over time
      texdata[16 * j + 8 + 5] = packHalf2x16(attrs.omega_0, attrs.omega_1);
      texdata[16 * j + 8 + 6] = packHalf2x16(attrs.omega_2, attrs.omega_3);

      // trbf temporal radial basis function parameters
      texdata[16 * j + 8 + 7] = packHalf2x16(attrs.trbf_center, Math.exp(attrs.trbf_scale));
    }
    console.timeEnd("build buffer");

    console.log("Scene Bytes", texdata.buffer.byteLength);

    self.postMessage({ texdata, texwidth, texheight }, [texdata.buffer]);
  }

  self.onmessage = (e) => {
    if (e.data.texture) {
      let texture = e.data.texture;
      vertexCount = Math.floor((texture.byteLength - e.data.remaining) / 4 / 16);
      positions = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        positions[3 * i + 0] = texture[16 * i + 0];
        positions[3 * i + 1] = texture[16 * i + 1];
        positions[3 * i + 2] = texture[16 * i + 2];
      }
      throttledSort();
    } else if (e.data.vertexCount) {
      vertexCount = e.data.vertexCount;
    } else if (e.data.view) {
      viewProj = e.data.view;
      throttledSort();
    } else if (e.data.ply) {
      vertexCount = 0;
      vertexCount = processPlyBuffer(e.data.ply);
    }
  };
}

const vertexShaderSource = `
  #version 300 es
  precision highp float;
  precision highp int;
  
  uniform highp usampler2D u_texture;
  uniform mat4 projection, view;
  uniform vec2 focal;
  uniform vec2 viewport;
  uniform float time;
  
  in vec2 position;
  in int index;
  
  out vec4 vColor;
  out vec2 vPosition;
  
  void main () {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);

      uvec4 motion1 = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 2) | 3u, uint(index) >> 10), 0);
      vec2 trbf = unpackHalf2x16(motion1.w);
      float dt = time - trbf.x;

      float topacity = exp(-1.0 * pow(dt / trbf.y, 2.0));
      //if(topacity < 0.02) return;

      uvec4 motion0 = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 2) | 2u, uint(index) >> 10), 0);
      uvec4 static0 = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 2), uint(index) >> 10), 0);

      vec2 m0 = unpackHalf2x16(motion0.x), m1 = unpackHalf2x16(motion0.y), m2 = unpackHalf2x16(motion0.z), 
           m3 = unpackHalf2x16(motion0.w), m4 = unpackHalf2x16(motion1.x); 
      
      vec4 trot = vec4(unpackHalf2x16(motion1.y).xy, unpackHalf2x16(motion1.z).xy) * dt;
      vec3 tpos = (vec3(m0.xy, m1.x) * dt + vec3(m1.y, m2.xy) * dt*dt + vec3(m3.xy, m4.x) * dt*dt*dt);
      
      vec4 cam = view * vec4(uintBitsToFloat(static0.xyz) + tpos, 1);
      vec4 pos = projection * cam;
  
      float clip = 1.2 * pos.w;
      if (pos.z < -clip || pos.x < -clip || pos.x > clip || pos.y < -clip || pos.y > clip) return;
      uvec4 static1 = texelFetch(u_texture, ivec2(((uint(index) & 0x3ffu) << 2) | 1u, uint(index) >> 10), 0);

      vec4 rot = vec4(unpackHalf2x16(static0.w).xy, unpackHalf2x16(static1.x).xy) + trot;
      vec3 scale = vec3(unpackHalf2x16(static1.y).xy, unpackHalf2x16(static1.z).x);
      rot /= sqrt(dot(rot, rot));
  
      mat3 S = mat3(scale.x, 0.0, 0.0, 0.0, scale.y, 0.0, 0.0, 0.0, scale.z);
      mat3 R = mat3(
        1.0 - 2.0 * (rot.z * rot.z + rot.w * rot.w), 2.0 * (rot.y * rot.z - rot.x * rot.w), 2.0 * (rot.y * rot.w + rot.x * rot.z),
        2.0 * (rot.y * rot.z + rot.x * rot.w), 1.0 - 2.0 * (rot.y * rot.y + rot.w * rot.w), 2.0 * (rot.z * rot.w - rot.x * rot.y),
        2.0 * (rot.y * rot.w - rot.x * rot.z), 2.0 * (rot.z * rot.w + rot.x * rot.y), 1.0 - 2.0 * (rot.y * rot.y + rot.z * rot.z));
      mat3 M = S * R;
      mat3 Vrk = 4.0 * transpose(M) * M;
      mat3 J = mat3(
          focal.x / cam.z, 0., -(focal.x * cam.x) / (cam.z * cam.z), 
          0., -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z), 
          0., 0., 0.
      );
  
      mat3 T = transpose(mat3(view)) * J;
      mat3 cov2d = transpose(T) * Vrk * T;
  
      float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
      float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
      float lambda1 = mid + radius, lambda2 = mid - radius;
  
      if(lambda2 < 0.0) return;
      vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));
      vec2 majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
      vec2 minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);
      
      uint rgba = static1.w;

      vColor = 
        clamp(pos.z/pos.w+1.0, 0.0, 1.0) * 
        vec4(1.0, 1.0, 1.0, topacity) *
        vec4(
          (rgba) & 0xffu,
          (rgba >> 8) & 0xffu,
          (rgba >> 16) & 0xffu,
          (rgba >> 24) & 0xffu) / 255.0;
      //vColor = clamp(vColor, 0.0, 1.0);

      vec2 vCenter = vec2(pos) / pos.w;
      gl_Position = vec4(
          vCenter 
          + position.x * majorAxis / viewport 
          + position.y * minorAxis / viewport, 0.0, 1.0);

      vPosition = position;
  }
  `.trim();

const fragmentShaderSource = `
  #version 300 es
  precision highp float;
  
  in vec4 vColor;
  in vec2 vPosition;
  
  out vec4 fragColor;
  
  void main () {
      float A = -dot(vPosition, vPosition);
      if (A < -4.0) discard;
      float B = exp(A) * vColor.a;
      fragColor = vec4(B * vColor.rgb, B);
  }
  
  `.trim();

let defaultViewMatrix = getViewMatrix(camera);

let viewMatrix = defaultViewMatrix;
async function main() {
  let carousel = false;
  const params = new URLSearchParams(location.search);
  try {
    viewMatrix = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    carousel = false;
  } catch (err) {}

  const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
  let splatData = new Uint8Array([]);
  const downsample = splatData.length / rowLength > 500000 ? 1 : 1 / devicePixelRatio;
  console.log(splatData.length / rowLength, downsample);

  const worker = new Worker(
    URL.createObjectURL(
      new Blob(["(", createWorker.toString(), ")(self)"], {
        type: "application/javascript",
      })
    )
  );

  const canvas = document.getElementById("canvas");
  const fps = document.getElementById("fps");
  //camera.width = 1024;
  // 根据 canvas 的宽高比计算高度
  //camera.height = (canvas.offsetHeight / canvas.offsetWidth) * camera.width;
  // 设置 fx 和 fy 为宽度的四分之一
  //camera.fx = camera.width / 4;
  //camera.fy = camera.width / 4;
  //camera.position.x = 0.0;
  //camera.position.y = 0.0;
  //camera.position.z = -radius;
  console.log("Camera Data", camera.width, camera.height, camera.fx, camera.fy, camera.position);
  //   const camid = document.getElementById("camid");

  let projectionMatrix;

  const gl = canvas.getContext("webgl2", {
    antialias: false,
  });

  const vertexShader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertexShader, vertexShaderSource);
  gl.compileShader(vertexShader);
  if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vertexShader));

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragmentShader, fragmentShaderSource);
  gl.compileShader(fragmentShader);
  if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fragmentShader));

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.useProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));

  gl.disable(gl.DEPTH_TEST); // Disable depth testing

  // Enable blending
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);

  const u_projection = gl.getUniformLocation(program, "projection");
  const u_viewport = gl.getUniformLocation(program, "viewport");
  const u_focal = gl.getUniformLocation(program, "focal");
  const u_view = gl.getUniformLocation(program, "view");
  const u_time = gl.getUniformLocation(program, "time");

  // positions
  const triangleVertices = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, triangleVertices, gl.STATIC_DRAW);
  const a_position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(a_position);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

  var texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  var u_textureLocation = gl.getUniformLocation(program, "u_texture");
  gl.uniform1i(u_textureLocation, 0);

  const indexBuffer = gl.createBuffer();
  const a_index = gl.getAttribLocation(program, "index");
  gl.enableVertexAttribArray(a_index);
  gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
  gl.vertexAttribIPointer(a_index, 1, gl.INT, false, 0, 0);
  gl.vertexAttribDivisor(a_index, 1);

  const resize = () => {
    gl.uniform2fv(u_focal, new Float32Array([camera.fx, camera.fy]));

    projectionMatrix = getProjectionMatrix(camera.fx, camera.fy, innerWidth, innerHeight);

    gl.uniform2fv(u_viewport, new Float32Array([innerWidth, innerHeight]));

    gl.canvas.width = Math.round(innerWidth / downsample);
    gl.canvas.height = Math.round(innerHeight / downsample);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    gl.uniformMatrix4fv(u_projection, false, projectionMatrix);
    console.log('resize', camera.fx, camera.fy, innerWidth, innerHeight, downsample)
  };

  window.addEventListener("resize", resize);
  resize();

  worker.onmessage = (e) => {
    if (e.data.texdata) {
      const { texdata, texwidth, texheight } = e.data;
      console.log('Test circle', cameras)
      const json = new TextEncoder().encode(
        JSON.stringify([
          {
            type: "splat",
            size: texdata.byteLength,
            texwidth: texwidth,
            texheight: texheight,
            cameras: cameras,
          },
        ])
      );
      const magic = new Uint32Array(2);
      magic[0] = 0x674b;
      magic[1] = json.length;
      const blob = new Blob([magic.buffer, json.buffer, texdata.buffer], {
        type: "application/octet-stream",
      });

      readChunks(new Response(blob).body.getReader(), [{ size: 8, type: "magic" }], chunkHandler);

      const link = document.createElement("a");
      link.download = "model.splatv";
      link.href = URL.createObjectURL(blob);
      document.body.appendChild(link);
      link.click();
    } else if (e.data.depthIndex) {
      const { depthIndex, viewProj } = e.data;
      gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
      vertexCount = e.data.vertexCount;
    }
  };

  let activeKeys = [];
  let currentCameraIndex = 0;

  let target = new Vector3(0, 0, 0);

  let desiredTarget = target.clone()
  let desiredAlpha = alpha
  let desiredBeta = beta
  let desiredRadius = radius

  let dragging = false;
  let panning = false;
  let lastDist = 0;
  let lastX = 0;
  let lastY = 0;

  let isUpdatingCamera = false
  const onCameraChange = () => {
    if (isUpdatingCamera) return

    const eulerRotation = camera.rotation.toEuler()
    desiredAlpha = -eulerRotation.y
    desiredBeta = -eulerRotation.x

    const x =
        camera.position.x -
        desiredRadius * Math.sin(desiredAlpha) * Math.cos(desiredBeta)
    const y = camera.position.y + desiredRadius * Math.sin(desiredBeta)
    const z =
        camera.position.z +
        desiredRadius * Math.cos(desiredAlpha) * Math.cos(desiredBeta)

    desiredTarget = new Vector3(x, y, z)
  }

  //camera.addEventListener("objectChanged", onCameraChange)

  const onMouseDown = e => {
      preventDefault(e)

      dragging = true
      panning = e.button === 2
      lastX = e.clientX
      lastY = e.clientY
      window.addEventListener("mouseup", onMouseUp)
  }

  const onMouseUp = e => {
      preventDefault(e)

      dragging = false
      panning = false
      window.removeEventListener("mouseup", onMouseUp)
  }

  const onMouseMove = e => {
      preventDefault(e)

      if (!dragging || !camera) return

      const dx = e.clientX - lastX
      const dy = e.clientY - lastY

      if (panning) {
          const zoomNorm = computeZoomNorm()
          const panX = -dx * panSpeed * 0.01 * zoomNorm
          const panY = -dy * panSpeed * 0.01 * zoomNorm
          const R = Matrix3.RotationFromQuaternion(camera.rotation).buffer
          const right = new Vector3(R[0], R[3], R[6])
          const up = new Vector3(R[1], R[4], R[7])
          desiredTarget = desiredTarget.add(right.multiply(panX))
          desiredTarget = desiredTarget.add(up.multiply(panY))

          if (maxPanDistance !== undefined) {
              if (desiredTarget.magnitude() > 0.0) {
                  const mag = Math.min(desiredTarget.magnitude(), maxPanDistance)
                  desiredTarget = desiredTarget.normalize().multiply(mag)
              }
          }
      } else {
          desiredAlpha -= dx * orbitSpeed * 0.003
          desiredBeta += dy * orbitSpeed * 0.003
          desiredBeta = Math.min(
              Math.max(desiredBeta, (minAngle * Math.PI) / 180),
              (maxAngle * Math.PI) / 180
          )
      }

      // 打印desiredAlpha, desiredBeta, desiredRadius
      console.log(desiredAlpha, desiredBeta, desiredRadius)

      lastX = e.clientX
      lastY = e.clientY
  }

  const onWheel = e => {
      preventDefault(e)

      const zoomNorm = 0.1 + (0.9 * (desiredRadius - minZoom)) / (maxZoom - minZoom)
      desiredRadius += e.deltaY * zoomSpeed * 0.025 * zoomNorm
      desiredRadius = Math.min(
          Math.max(desiredRadius, minZoom),
          maxZoom
      )
  }
  // 监听鼠标
  window.addEventListener("mousedown", onMouseDown)
  window.addEventListener("mousemove", onMouseMove)
  window.addEventListener("wheel", onWheel)

  let isButtonOn = false; // 按钮初始状态为关闭
  let stopTime = 0; // 记录停止时间点
  let openTime = 0; // 记录打开时间点
  let pauseTime = 0; // 记录暂停时间
  
  const toggleButton = document.getElementById('toggleButton');
  
  toggleButton.addEventListener('click', function() {
    isButtonOn = !isButtonOn;
  
    if (isButtonOn) {
      toggleButton.textContent = 'Play';
      stopTime = Date.now();
      console.log('stop:', stopTime);
    } else {
      toggleButton.textContent = 'Pause';
      openTime = Date.now();
      pauseTime += openTime - stopTime;
      console.log('open:', openTime);
    }
  });
  
  const lerp = (a, b, t) => {
      return (1 - t) * a + t * b
  }
  
  const rotateCameraAngle = (deltaAlpha, deltaBeta) => {
      desiredAlpha += deltaAlpha;
      deltaBeta += deltaBeta;
  }
  
  const update = () => {
      isUpdatingCamera = true

      alpha = lerp(alpha, desiredAlpha, dampening)
      beta = lerp(beta, desiredBeta, dampening)
      radius = lerp(radius, desiredRadius, dampening)
      target = target.lerp(desiredTarget, dampening)

      if (Math.sign(radius) !== Math.sign(lastRadius)) {
        radiusSignChanged = -radiusSignChanged;
      } 

      const x = target.x + radius * Math.sin(alpha) * Math.cos(beta)
      const y = target.y - radius * Math.sin(beta)
      const z = target.z - radius * Math.cos(alpha) * Math.cos(beta)
      camera.position = new Vector3(x, y, z)

      const direction = target.subtract(camera.position).normalize()
      const rx = Math.asin(-radiusSignChanged*direction.y)
      const ry = Math.atan2(radiusSignChanged*direction.x, radiusSignChanged*direction.z)
      camera.rotation = Quaternion.FromEuler(new Vector3(rx, ry, 0))

      const moveSpeed = 0.025
      const rotateSpeed = 0.01

      const R = Matrix3.RotationFromQuaternion(camera.rotation).buffer
      const forward = new Vector3(-R[2], -R[5], -R[8])
      const right = new Vector3(R[0], R[3], R[6])

      lastRadius = radius
      isUpdatingCamera = false
  }


  let altX = 0,
    altY = 0;  

  let jumpDelta = 0;
  let vertexCount = 0;

  let lastFrame = 0;
  let avgFps = 0;
  let start = 0;

  window.addEventListener("gamepadconnected", (e) => {
    const gp = navigator.getGamepads()[e.gamepad.index];
    console.log(`Gamepad connected at index ${gp.index}: ${gp.id}. It has ${gp.buttons.length} buttons and ${gp.axes.length} axes.`);
  });
  window.addEventListener("gamepaddisconnected", (e) => {
    console.log("Gamepad disconnected");
  });

  let leftGamepadTrigger, rightGamepadTrigger;

  const frame = (now) => {
    
    update();
    // 打印camera的position和rotation
    viewMatrix = getViewMatrix(camera);

    jumpDelta = Math.max(0, jumpDelta - 0.05);

    let actualViewMatrix = viewMatrix;

    const viewProj = multiply4(projectionMatrix, actualViewMatrix);
    worker.postMessage({ view: viewProj });

    const currentFps = 1000 / (now - lastFrame) || 0;
    avgFps = (isFinite(avgFps) && avgFps) * 0.9 + currentFps * 0.1;

    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    
    if (vertexCount > 0) {
      document.getElementById("spinner").style.display = "none";
      gl.uniformMatrix4fv(u_view, false, actualViewMatrix);
      if (isButtonOn) {
        gl.uniform1f(u_time, (Math.sin((stopTime - pauseTime) / 1000) / 2 + 1 / 2) * 48 / 49);
      } else {
        gl.uniform1f(u_time, (Math.sin((Date.now()-pauseTime) / 1000) / 2 + 1 / 2) * 48 / 49);
      }
      // gl.uniform1f(u_time, Math.sin(Date.now() / 1000) / 2 + 1 / 2);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount);
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT);
      document.getElementById("spinner").style.display = "";
      start = Date.now() + 2000;
    }
    const progress = (100 * vertexCount) / (splatData.length / rowLength);
    if (progress < 100) {
      document.getElementById("progress").style.width = progress + "%";
    } else {
      document.getElementById("progress").style.display = "none";
    }
    fps.innerText = Math.round(avgFps) + " fps";
    lastFrame = now;
    requestAnimationFrame(frame);
  };

  frame();

  const selectFile = (file) => {
    const fr = new FileReader();
    if (/\.json$/i.test(file.name)) {
      fr.onload = () => {
        cameras = JSON.parse(fr.result);
        viewMatrix = getViewMatrix(cameras[0]);
        projectionMatrix = getProjectionMatrix(camera.fx / downsample, camera.fy / downsample, canvas.width, canvas.height);
        gl.uniformMatrix4fv(u_projection, false, projectionMatrix);

        console.log("Loaded Cameras");
      };
      fr.readAsText(file);
    } else {
      // stopLoading = true;
      fr.onload = () => {
        splatData = new Uint8Array(fr.result);
        console.log("Loaded", Math.floor(splatData.length / rowLength));

        if (splatData[0] == 112 && splatData[1] == 108 && splatData[2] == 121 && splatData[3] == 10) {
          // ply file magic header means it should be handled differently
          worker.postMessage({ ply: splatData.buffer });
        } else if (splatData[0] == 75 && splatData[1] == 103) {
          // splatv file
          readChunks(new Response(splatData).body.getReader(), [{ size: 8, type: "magic" }], chunkHandler).then(() => {
            currentCameraIndex = 0;
            camera = cameras[currentCameraIndex];
            //console.log("Camera Data", camera.width, camera.height, camera.fx, camera.fy)
            viewMatrix = getViewMatrix(camera);
          });
        } else {
          alert("Unsupported file format!");
        }
      };
      fr.readAsArrayBuffer(file);
    }
  };

  window.addEventListener("hashchange", (e) => {
    try {
      viewMatrix = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      carousel = false;
    } catch (err) {}
  });

  const preventDefault = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("dragenter", preventDefault);
  document.addEventListener("dragover", preventDefault);
  document.addEventListener("dragleave", preventDefault);
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectFile(e.dataTransfer.files[0]);
  });

  let lastVertexCount = -1;
  const chunkHandler = (chunk, buffer, remaining, chunks) => {
    if (!remaining && chunk.type === "magic") {
      let intView = new Uint32Array(buffer);
      if (intView[0] !== 0x674b) throw new Error("This does not look like a splatv file");
      chunks.push({ size: intView[1], type: "chunks" });
    } else if (!remaining && chunk.type === "chunks") {
      for (let chunk of JSON.parse(new TextDecoder("utf-8").decode(buffer))) {
        chunks.push(chunk);
        if (chunk.type === "splat") {
          cameras = chunk.cameras;
          camera = chunk.cameras[0];
          console.log("Camera Data", camera)
          resize();
        }
      }
    } else if (chunk.type === "splat") {
      if (vertexCount > lastVertexCount || remaining === 0) {
        lastVertexCount = vertexCount;
        worker.postMessage({ texture: new Float32Array(buffer), remaining: remaining });
        console.log("splat", remaining);

        const texdata = new Uint32Array(buffer);
        // console.log(texdata);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, chunk.texwidth, chunk.texheight, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, texdata);
      }
    } else if (!remaining) {
      console.log("chunk", chunk, buffer);
    }
  };

  //const url = params.get("url") ? new URL(params.get("url"), "https://huggingface.co/cakewalk/splat-data/resolve/main/") : "model.splatv";
  //const url = new URL("flame.splatv", "https://huggingface.co/cakewalk/splat-data/resolve/main/");
  //const req = await fetch(url, { mode: "cors", credentials: "omit" });
  //if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);

  //await readChunks(req.body.getReader(), [{ size: 8, type: "magic" }], chunkHandler);
}

main().catch((err) => {
  document.getElementById("spinner").style.display = "none";
  document.getElementById("message").innerText = err.toString();
});

function attachShaders(gl, vertexShaderSource, fragmentShaderSource) {
  const vertexShader = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vertexShader, vertexShaderSource);
  gl.compileShader(vertexShader);
  if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vertexShader));

  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fragmentShader, fragmentShaderSource);
  gl.compileShader(fragmentShader);
  if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fragmentShader));

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.useProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));
  return program;
}

async function readChunks(reader, chunks, handleChunk) {
  let chunk = chunks.shift();
  let buffer = new Uint8Array(chunk.size);
  let offset = 0;
  while (chunk) {
    let { done, value } = await reader.read();
    if (done) break;
    while (value.length + offset >= chunk.size) {
      buffer.set(value.subarray(0, chunk.size - offset), offset);
      value = value.subarray(chunk.size - offset);
      handleChunk(chunk, buffer.buffer, 0, chunks);
      chunk = chunks.shift();
      if (!chunk) break;
      buffer = new Uint8Array(chunk.size);
      offset = 0;
    }
    if (!chunk) break;
    buffer.set(value, offset);
    offset += value.length;
    handleChunk(chunk, buffer.buffer, buffer.byteLength - offset, chunks);
  }
  if (chunk) handleChunk(chunk, buffer.buffer, 0, chunks);
}

function getProjectionMatrix(fx, fy, width, height) {
  const znear = 0.2;
  const zfar = 200;
  return [
    [(2 * fx) / width, 0, 0, 0],
    [0, -(2 * fy) / height, 0, 0],
    [0, 0, zfar / (zfar - znear), 1],
    [0, 0, -(zfar * znear) / (zfar - znear), 0],
  ].flat();
}

function getViewMatrix(camera) {
  const R = Matrix3.RotationFromQuaternion(camera.rotation).buffer;
  const t = camera.position;
  const camToWorld = [
    [R[0], R[1], R[2], 0],
    [R[3], R[4], R[5], 0],
    [R[6], R[7], R[8], 0],
    [-t.x * R[0] - t.y * R[3] - t.z * R[6], -t.x * R[1] - t.y * R[4] - t.z * R[7], -t.x * R[2] - t.y * R[5] - t.z * R[8], 1],
  ].flat();
  return camToWorld;
}

function multiply4(a, b) {
  return [
    b[0] * a[0] + b[1] * a[4] + b[2] * a[8] + b[3] * a[12],
    b[0] * a[1] + b[1] * a[5] + b[2] * a[9] + b[3] * a[13],
    b[0] * a[2] + b[1] * a[6] + b[2] * a[10] + b[3] * a[14],
    b[0] * a[3] + b[1] * a[7] + b[2] * a[11] + b[3] * a[15],
    b[4] * a[0] + b[5] * a[4] + b[6] * a[8] + b[7] * a[12],
    b[4] * a[1] + b[5] * a[5] + b[6] * a[9] + b[7] * a[13],
    b[4] * a[2] + b[5] * a[6] + b[6] * a[10] + b[7] * a[14],
    b[4] * a[3] + b[5] * a[7] + b[6] * a[11] + b[7] * a[15],
    b[8] * a[0] + b[9] * a[4] + b[10] * a[8] + b[11] * a[12],
    b[8] * a[1] + b[9] * a[5] + b[10] * a[9] + b[11] * a[13],
    b[8] * a[2] + b[9] * a[6] + b[10] * a[10] + b[11] * a[14],
    b[8] * a[3] + b[9] * a[7] + b[10] * a[11] + b[11] * a[15],
    b[12] * a[0] + b[13] * a[4] + b[14] * a[8] + b[15] * a[12],
    b[12] * a[1] + b[13] * a[5] + b[14] * a[9] + b[15] * a[13],
    b[12] * a[2] + b[13] * a[6] + b[14] * a[10] + b[15] * a[14],
    b[12] * a[3] + b[13] * a[7] + b[14] * a[11] + b[15] * a[15],
  ];
}

function invert4(a) {
  let b00 = a[0] * a[5] - a[1] * a[4];
  let b01 = a[0] * a[6] - a[2] * a[4];
  let b02 = a[0] * a[7] - a[3] * a[4];
  let b03 = a[1] * a[6] - a[2] * a[5];
  let b04 = a[1] * a[7] - a[3] * a[5];
  let b05 = a[2] * a[7] - a[3] * a[6];
  let b06 = a[8] * a[13] - a[9] * a[12];
  let b07 = a[8] * a[14] - a[10] * a[12];
  let b08 = a[8] * a[15] - a[11] * a[12];
  let b09 = a[9] * a[14] - a[10] * a[13];
  let b10 = a[9] * a[15] - a[11] * a[13];
  let b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  return [
    (a[5] * b11 - a[6] * b10 + a[7] * b09) / det,
    (a[2] * b10 - a[1] * b11 - a[3] * b09) / det,
    (a[13] * b05 - a[14] * b04 + a[15] * b03) / det,
    (a[10] * b04 - a[9] * b05 - a[11] * b03) / det,
    (a[6] * b08 - a[4] * b11 - a[7] * b07) / det,
    (a[0] * b11 - a[2] * b08 + a[3] * b07) / det,
    (a[14] * b02 - a[12] * b05 - a[15] * b01) / det,
    (a[8] * b05 - a[10] * b02 + a[11] * b01) / det,
    (a[4] * b10 - a[5] * b08 + a[7] * b06) / det,
    (a[1] * b08 - a[0] * b10 - a[3] * b06) / det,
    (a[12] * b04 - a[13] * b02 + a[15] * b00) / det,
    (a[9] * b02 - a[8] * b04 - a[11] * b00) / det,
    (a[5] * b07 - a[4] * b09 - a[6] * b06) / det,
    (a[0] * b09 - a[1] * b07 + a[2] * b06) / det,
    (a[13] * b01 - a[12] * b03 - a[14] * b00) / det,
    (a[8] * b03 - a[9] * b01 + a[10] * b00) / det,
  ];
}

function rotate4(a, rad, x, y, z) {
  let len = Math.hypot(x, y, z);
  x /= len;
  y /= len;
  z /= len;
  let s = Math.sin(rad);
  let c = Math.cos(rad);
  let t = 1 - c;
  let b00 = x * x * t + c;
  let b01 = y * x * t + z * s;
  let b02 = z * x * t - y * s;
  let b10 = x * y * t - z * s;
  let b11 = y * y * t + c;
  let b12 = z * y * t + x * s;
  let b20 = x * z * t + y * s;
  let b21 = y * z * t - x * s;
  let b22 = z * z * t + c;
  return [
    a[0] * b00 + a[4] * b01 + a[8] * b02,
    a[1] * b00 + a[5] * b01 + a[9] * b02,
    a[2] * b00 + a[6] * b01 + a[10] * b02,
    a[3] * b00 + a[7] * b01 + a[11] * b02,
    a[0] * b10 + a[4] * b11 + a[8] * b12,
    a[1] * b10 + a[5] * b11 + a[9] * b12,
    a[2] * b10 + a[6] * b11 + a[10] * b12,
    a[3] * b10 + a[7] * b11 + a[11] * b12,
    a[0] * b20 + a[4] * b21 + a[8] * b22,
    a[1] * b20 + a[5] * b21 + a[9] * b22,
    a[2] * b20 + a[6] * b21 + a[10] * b22,
    a[3] * b20 + a[7] * b21 + a[11] * b22,
    ...a.slice(12, 16),
  ];
}

function translate4(a, x, y, z) {
  return [
    ...a.slice(0, 12),
    a[0] * x + a[4] * y + a[8] * z + a[12],
    a[1] * x + a[5] * y + a[9] * z + a[13],
    a[2] * x + a[6] * y + a[10] * z + a[14],
    a[3] * x + a[7] * y + a[11] * z + a[15],
  ];
}

// 设置一个可以在别的文件调用的方法，来更换vertex数据
async function setVertexData(filename) {
  //vertexcount
  const url = new URL(filename, "https://huggingface.co/datasets/Marooooo/HoloTime_results/resolve/main/");
  const req = await fetch(url, { mode: "cors", credentials: "omit" });
  if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);

  await readChunks(req.body.getReader(), [{ size: 8, type: "magic" }], chunkHandler);
}

export {setVertexData}