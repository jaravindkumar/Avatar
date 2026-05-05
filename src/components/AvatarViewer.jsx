import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SMPLRenderer } from '../utils/SMPLRenderer.js';
import { SyntheticAvatarRenderer } from '../utils/SyntheticAvatarRenderer.js';

/**
 * Three.js 3D avatar viewer.
 *
 * Rendering priority:
 *  1. SMPL mesh   – when smplModel + frameParams are available
 *  2. Synthetic capsule avatar – always available from keypoints3d (default)
 *  3. Skeleton overlay – dots/lines, toggled via viewMode='skeleton'
 *
 * Props:
 *  smplModel    - parsed SMPL JSON (optional; enables mesh mode)
 *  frameParams  - [{pose, shape, globalTrans}] per frame (SMPL only)
 *  currentFrame - index to render
 *  displayMode  - 'solid' | 'wireframe'
 *  viewMode     - 'avatar' | 'skeleton' | 'sidebyside'
 *  keypoints3d  - [{x,y,z,confidence}] for current frame
 *  onReady      - ({canvas, renderFrame}) callback for VideoExporter
 */
export default function AvatarViewer({
  smplModel,
  frameParams,
  currentFrame = 0,
  displayMode = 'solid',
  viewMode = 'avatar',
  keypoints3d,
  onReady,
}) {
  const mountRef = useRef(null);
  const threeRef = useRef(null);

  // ---- Scene setup (re-runs when smplModel changes) ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // WebGL renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
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

    // Orbit controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 1;
    controls.maxDistance = 10;

    // 3-point lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
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

    // Grid
    scene.add(new THREE.GridHelper(10, 20, 0x334455, 0x222233));

    // ---- Renderers ----

    // 1. Synthetic capsule avatar (always available)
    const synthRenderer = new SyntheticAvatarRenderer();
    scene.add(synthRenderer.group);

    // 2. SMPL mesh renderer (optional)
    let smplRenderer = null;
    if (smplModel) {
      try {
        smplRenderer = new SMPLRenderer(smplModel);
        const mat = new THREE.MeshPhongMaterial({
          color: 0x4488ff, emissive: 0x111122,
          specular: 0xaabbff, shininess: 40,
          side: THREE.DoubleSide,
        });
        scene.add(smplRenderer.buildMesh(mat));
      } catch (err) {
        console.warn('SMPL renderer init failed:', err);
      }
    }

    // 3. Skeleton overlay group
    const skeletonGroup = new THREE.Group();
    scene.add(skeletonGroup);

    // Render loop
    let animId;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Resize
    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);

    threeRef.current = { scene, camera, renderer, controls, smplRenderer, synthRenderer, skeletonGroup };

    onReady?.({
      canvas: renderer.domElement,
      renderFrame: (fi) => {
        applyFrame(fi, threeRef.current);
        renderer.render(scene, camera);
      },
    });

    return () => {
      cancelAnimationFrame(animId);
      ro.disconnect();
      controls.dispose();
      smplRenderer?.dispose();
      synthRenderer.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      threeRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smplModel]);

  // ---- Per-frame update ----
  useEffect(() => {
    if (!threeRef.current) return;
    applyFrame(currentFrame, threeRef.current);
  }, [currentFrame, frameParams, keypoints3d]);

  // ---- Wireframe toggle ----
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    t.synthRenderer?.setWireframe(displayMode === 'wireframe');
    if (t.smplRenderer?.mesh) t.smplRenderer.mesh.material.wireframe = displayMode === 'wireframe';
  }, [displayMode]);

  // ---- View mode visibility ----
  useEffect(() => {
    const t = threeRef.current;
    if (!t) return;
    const showAvatar   = viewMode === 'avatar' || viewMode === 'sidebyside';
    const showSkeleton = viewMode === 'skeleton';

    t.synthRenderer.group.visible = showAvatar && !t.smplRenderer;
    if (t.smplRenderer?.mesh) t.smplRenderer.mesh.visible = showAvatar && !!t.smplRenderer;
    t.skeletonGroup.visible = showSkeleton;
  }, [viewMode]);

  // Helper: apply frame data to scene
  function applyFrame(fi, three) {
    if (!three) return;
    const { smplRenderer, synthRenderer, skeletonGroup } = three;

    // SMPL deformation (when model is loaded)
    if (smplRenderer && frameParams?.[fi]) {
      const { pose, shape, globalTrans } = frameParams[fi];
      smplRenderer.deform(pose, shape, globalTrans ?? [0, 0, 0]);
    }

    // Synthetic capsule avatar (always update from keypoints)
    if (keypoints3d) {
      synthRenderer.update(keypoints3d);
    }

    // Skeleton overlay
    if (viewMode === 'skeleton' && keypoints3d) {
      buildSkeletonLines(skeletonGroup, keypoints3d);
    }
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }} ref={mountRef} />
  );
}

// ---- Skeleton line helper ----

const MP_BONES = [
  [11,12],[11,23],[12,24],[23,24],   // torso
  [11,13],[13,15],                    // left arm
  [12,14],[14,16],                    // right arm
  [23,25],[25,27],[27,29],            // left leg
  [24,26],[26,28],[28,30],            // right leg
  [0,7],[0,8],                        // head
];

function buildSkeletonLines(group, kps) {
  while (group.children.length) group.remove(group.children[0]);
  if (!kps) return;

  const jGeo = new THREE.SphereGeometry(0.025, 6, 6);
  const jMat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
  kps.forEach(kp => {
    if (!kp || kp.confidence < 0.3) return;
    const s = new THREE.Mesh(jGeo, jMat);
    s.position.set(kp.x, kp.y, -kp.z);
    group.add(s);
  });

  const pts = [];
  for (const [a, b] of MP_BONES) {
    const kA = kps[a], kB = kps[b];
    if (!kA || !kB || kA.confidence < 0.3 || kB.confidence < 0.3) continue;
    pts.push(new THREE.Vector3(kA.x, kA.y, -kA.z));
    pts.push(new THREE.Vector3(kB.x, kB.y, -kB.z));
  }
  if (pts.length) {
    group.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffaa00 })
    ));
  }
}
