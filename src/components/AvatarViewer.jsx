import { useEffect, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SMPLRenderer } from '../utils/SMPLRenderer.js';

/**
 * Three.js 3D avatar viewer.
 *
 * Props:
 *  smplModel      - parsed SMPL JSON model data (or null if unavailable)
 *  frameParams    - array of {pose, shape, globalTrans} per frame (or null)
 *  currentFrame   - index into frameParams to render
 *  displayMode    - 'solid' | 'wireframe'
 *  viewMode       - 'avatar' | 'skeleton' | 'sidebyside'
 *  keypoints3d    - optional raw 3D keypoints for current frame (for skeleton view)
 *  onReady        - called with {canvas, renderFrame} so VideoExporter can capture
 */
export default function AvatarViewer({
  smplModel,
  frameParams,
  currentFrame = 0,
  displayMode = 'solid',
  viewMode = 'avatar',
  keypoints3d,
  videoFrame,  // HTMLCanvasElement for side-by-side
  onReady,
}) {
  const mountRef      = useRef(null);
  const threeRef      = useRef(null); // { scene, camera, renderer, controls, smplRenderer, skeletonGroup }
  const animFrameRef  = useRef(null);

  // ---- Scene setup ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1117);
    scene.fog = new THREE.Fog(0x0f1117, 8, 20);

    // Camera
    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.set(0, 1.0, 4.0);
    camera.lookAt(0, 1.0, 0);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1;
    controls.maxDistance = 10;

    // Lighting — 3-point setup
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(3, 5, 3);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.setScalar(1024);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x8899ff, 0.5);
    fillLight.position.set(-3, 3, 1);
    scene.add(fillLight);

    const backLight = new THREE.DirectionalLight(0xffcc88, 0.3);
    backLight.position.set(0, 2, -4);
    scene.add(backLight);

    // Grid floor
    const grid = new THREE.GridHelper(10, 20, 0x334455, 0x222233);
    grid.position.y = 0;
    scene.add(grid);

    // Skeleton group (for keypoint visualisation)
    const skeletonGroup = new THREE.Group();
    scene.add(skeletonGroup);

    // SMPL mesh (if model available)
    let smplRenderer = null;
    if (smplModel) {
      try {
        smplRenderer = new SMPLRenderer(smplModel);
        const material = new THREE.MeshPhongMaterial({
          color: 0x4488ff,
          emissive: 0x111122,
          specular: 0xaabbff,
          shininess: 40,
          side: THREE.DoubleSide,
        });
        const mesh = smplRenderer.buildMesh(material);
        scene.add(mesh);
      } catch (err) {
        console.warn('SMPL renderer init failed:', err);
      }
    }

    // Render loop
    let animId;
    function animate() {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();
    animFrameRef.current = animId;

    // Resize handler
    function onResize() {
      if (!mount) return;
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    threeRef.current = { scene, camera, renderer, controls, smplRenderer, skeletonGroup };

    // Notify parent so VideoExporter can use the canvas
    onReady?.({
      canvas: renderer.domElement,
      renderFrame: (frameIdx) => {
        updateFrame(frameIdx, threeRef.current);
        renderer.render(scene, camera);
      },
    });

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      controls.dispose();
      smplRenderer?.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      threeRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smplModel]);

  // ---- Update frame when currentFrame changes ----
  useEffect(() => {
    if (!threeRef.current) return;
    updateFrame(currentFrame, threeRef.current);
  }, [currentFrame, frameParams, keypoints3d]);

  // ---- Display mode toggle ----
  useEffect(() => {
    if (!threeRef.current?.smplRenderer?.mesh) return;
    const mat = threeRef.current.smplRenderer.mesh.material;
    mat.wireframe = displayMode === 'wireframe';
  }, [displayMode]);

  // ---- Skeleton visibility ----
  useEffect(() => {
    if (!threeRef.current?.skeletonGroup) return;
    threeRef.current.skeletonGroup.visible = viewMode === 'skeleton' || viewMode === 'sidebyside';
    if (threeRef.current.smplRenderer?.mesh) {
      threeRef.current.smplRenderer.mesh.visible = viewMode === 'avatar' || viewMode === 'sidebyside';
    }
  }, [viewMode]);

  function updateFrame(frameIdx, three) {
    if (!three) return;
    const { smplRenderer, skeletonGroup } = three;

    // SMPL mesh deformation
    if (smplRenderer && frameParams?.[frameIdx]) {
      const { pose, shape, globalTrans } = frameParams[frameIdx];
      smplRenderer.deform(pose, shape, globalTrans ?? [0, 0, 0]);
    }

    // Skeleton overlay
    if (keypoints3d) {
      buildSkeletonMesh(skeletonGroup, keypoints3d);
    }
  }

  return (
    <div className="relative w-full h-full" ref={mountRef}>
      {!smplModel && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-slate-500 text-sm">
            Load SMPL model to see avatar · skeleton preview available
          </p>
        </div>
      )}
    </div>
  );
}

// ---- Skeleton visualisation helpers ----

const MP_BONES = [
  // Torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // Left arm
  [11, 13], [13, 15],
  // Right arm
  [12, 14], [14, 16],
  // Left leg
  [23, 25], [25, 27], [27, 29], [29, 31],
  // Right leg
  [24, 26], [26, 28], [28, 30], [30, 32],
  // Head
  [0, 7], [0, 8], [7, 9], [8, 10],
];

function buildSkeletonMesh(group, keypoints3d) {
  // Remove existing children
  while (group.children.length > 0) group.remove(group.children[0]);

  if (!keypoints3d) return;

  // Joint spheres
  const jointGeo  = new THREE.SphereGeometry(0.03, 8, 8);
  const jointMat  = new THREE.MeshBasicMaterial({ color: 0x00ff88 });

  keypoints3d.forEach((kp) => {
    if (!kp || kp.confidence < 0.3) return;
    const sphere = new THREE.Mesh(jointGeo, jointMat);
    sphere.position.set(kp.x, kp.y, -kp.z); // flip Z for three.js convention
    group.add(sphere);
  });

  // Bone lines
  const points = [];
  for (const [a, b] of MP_BONES) {
    const kpA = keypoints3d[a], kpB = keypoints3d[b];
    if (!kpA || !kpB || kpA.confidence < 0.3 || kpB.confidence < 0.3) continue;
    points.push(new THREE.Vector3(kpA.x, kpA.y, -kpA.z));
    points.push(new THREE.Vector3(kpB.x, kpB.y, -kpB.z));
  }

  if (points.length > 0) {
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffaa00, linewidth: 2 });
    group.add(new THREE.LineSegments(lineGeo, lineMat));
  }
}
