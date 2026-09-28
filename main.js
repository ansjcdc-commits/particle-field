import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';

const CONFIG = {
  PARTICLE_COUNT: 20000, MIN_PARTICLES: 8500, MAX_PARTICLES: 30000,
  BASE_SPEED: 0.08, NOISE_STRENGTH: 0.45, DAMPING: 0.965,
  INTERACTION_RADIUS: 0.22, INTERACTION_STRENGTH: 1.6,
  ATTRACTION_STRENGTH: 0.8, REPULSION_STRENGTH: 1.8, SWIRL_STRENGTH: 1.8,
  POINT_ATTRACTION_MULTIPLIER: 2.0,
  OPEN_RESTORE_RATE: 5.2,
  FIST_PULL_STRENGTH: 3.2, FIST_BALL_RADIUS: 0.075,
  TURBULENCE: 0.6, PINCH_STRENGTH: 3.0, PINCH_RING_RADIUS: 0.34, EXPLOSION_STRENGTH: 4.0,
  TRAIL_ALPHA: 0.075, PARTICLE_SIZE: 1.2, GLOW: 1.5,
  CAMERA_SMOOTHING: 0.56, MAX_DPR: 2,
};

const stage = document.querySelector('#stage');
const cameraVideo = document.querySelector('#camera');
const cameraWrap = document.querySelector('#cameraWrap');
const landmarkCanvas = document.querySelector('#landmarks');
const cameraButton = document.querySelector('#cameraButton');
const trackingEl = document.querySelector('#tracking');
const cameraError = document.querySelector('#cameraError');
const debugButton = document.querySelector('#debugButton');
const debugPanel = document.querySelector('#debugPanel');
const gestureLabel = document.querySelector('#gestureLabel');
const landmarkCtx = landmarkCanvas.getContext('2d');

const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.domElement.className = 'webgl';
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, CONFIG.MAX_DPR));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 1);
renderer.autoClear = false;
stage.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 100);
camera.position.z = 23;

const trailScene = new THREE.Scene();
const trailCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const trailMaterial = new THREE.ShaderMaterial({
  depthTest: false, depthWrite: false,
  vertexShader: `void main(){ gl_Position=vec4(position,1.0); }`,
  fragmentShader: `uniform float alpha; void main(){ gl_FragColor=vec4(0.0,0.0,0.0,alpha); }`,
  uniforms: { alpha: { value: CONFIG.TRAIL_ALPHA } },
});
const trailQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), trailMaterial);
trailScene.add(trailQuad);

const vertexShader = `
  attribute float aSize; attribute float aSeed; attribute float aTone; attribute float aDepth;
  uniform float uTime; uniform float uStart; uniform float uPixelRatio;
  uniform vec2 uInteraction; uniform float uInteractionPower; uniform float uInteractionRadius;
  varying float vAlpha; varying float vTone;
  void main(){
    vec3 p=position*mix(0.025,1.0,smoothstep(0.0,1.0,uStart));
    float shimmer=0.78+0.22*sin(uTime*(0.7+aSeed*1.3)+aSeed*31.0);
    vec4 mv=modelViewMatrix*vec4(p,1.0);
    float depthScale=clamp(19.0/max(8.0,-mv.z),0.58,1.5);
    gl_PointSize=clamp(aSize*depthScale*uPixelRatio*300.0/max(8.0,-mv.z),0.8,7.5);
    gl_Position=projectionMatrix*mv;
    float interactionGlow=(1.0-smoothstep(0.0,uInteractionRadius,length(position.xy-uInteraction)))*uInteractionPower;
    vAlpha=(0.38+aTone*0.48+interactionGlow*0.82)*shimmer*mix(0.16,1.0,smoothstep(0.0,1.0,uStart))*mix(0.7,1.0,aDepth);
    vTone=aTone;
  }
`;
const fragmentShader = `
  varying float vAlpha; varying float vTone;
  void main(){
    vec2 q=gl_PointCoord-0.5; float r=length(q);
    float core=exp(-r*r*52.0); float halo=exp(-r*r*13.0);
    float alpha=(core*0.8+halo*0.2)*vAlpha;
    vec3 cold=mix(vec3(0.62,0.84,1.0),vec3(0.88,0.96,1.0),smoothstep(0.25,0.8,vTone));
    cold=mix(cold,vec3(0.39,0.73,1.0),smoothstep(0.82,1.0,vTone)*0.45);
    gl_FragColor=vec4(cold*alpha*2.1,alpha);
  }
`;

let count = CONFIG.PARTICLE_COUNT;
let geometry, points, positionAttr;
let positions, velocities, seeds, tones, depths, sizes;
let scatterTargets;
let helloTargets;
let ansjTargets;
let openRestore = 0;
let helloRestore = 0;
let ansjRestore = 0;
let spawnProgress = 0;
let performanceAverage = 60;
let fpsFrames = 0, fpsStart = performance.now(), currentFps = 60;
let lastFrame = performance.now();
let time = 0;
let handLandmarker = null;
let legacyHands = null;
let detectBusy = false;
let detectFailures = 0;
let cameraSession = 0;
let cameraStarting = false;
let hand = { detected: false, x: 0, y: 0, vx: 0, vy: 0, palmX: 0, palmY: 0, gesture: 'IDLE', pinch: 1, opened: false, lastSeen: 0 };
let pinchWasActive = false;
const pointer = { active: false, x: 0, y: 0, vx: 0, vy: 0, down: false, touches: 0, previousTime: performance.now() };

const visibleHeight = () => 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * camera.position.z;
const visibleWidth = () => visibleHeight() * camera.aspect;

function createParticles(newCount) {
  count = newCount;
  positions = new Float32Array(count * 3); velocities = new Float32Array(count * 3);
  scatterTargets = new Float32Array(count * 3);
  helloTargets = new Float32Array(count * 3);
  ansjTargets = new Float32Array(count * 3);
  seeds = new Float32Array(count); tones = new Float32Array(count); depths = new Float32Array(count); sizes = new Float32Array(count);
  const w = visibleWidth(), h = visibleHeight();
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    const mode = Math.random();
    let x, y;
    if (mode < 0.64) { const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()); x = Math.cos(a) * r * w * 0.43; y = Math.sin(a) * r * h * 0.41; }
    else if (mode < 0.84) { const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 2.4; x = Math.cos(a) * r + (Math.random()-.5)*w*.52; y = Math.sin(a) * r + (Math.random()-.5)*h*.52; }
    else { x = (Math.random()-.5)*w; y = (Math.random()-.5)*h; }
    const z = (Math.random()-.5)*13;
    positions[k] = x; positions[k+1] = y; positions[k+2] = z;
    velocities[k] = (Math.random()-.5)*0.025; velocities[k+1] = (Math.random()-.5)*0.025; velocities[k+2] = (Math.random()-.5)*0.015;
    seeds[i] = Math.random(); tones[i] = Math.pow(Math.random(), 1.65); depths[i] = Math.random();
    sizes[i] = CONFIG.PARTICLE_SIZE * (0.45 + Math.random()*0.95) * (z > 3 ? 1.13 : z < -3 ? .75 : 1);
  }
  buildScatterTargets();
  buildHelloTargets();
  buildANSJTargets();
  if (geometry) { geometry.dispose(); scene.remove(points); }
  geometry = new THREE.BufferGeometry();
  positionAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute('aTone', new THREE.BufferAttribute(tones, 1));
  geometry.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  const material = new THREE.ShaderMaterial({ uniforms: { uTime:{value:0}, uStart:{value:0}, uPixelRatio:{value:renderer.getPixelRatio()}, uInteraction:{value:new THREE.Vector2()}, uInteractionPower:{value:0}, uInteractionRadius:{value:visibleHeight()*CONFIG.INTERACTION_RADIUS*1.65} }, vertexShader, fragmentShader, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending });
  points = new THREE.Points(geometry, material); points.frustumCulled = false; scene.add(points);
}

function buildScatterTargets(){
  if(!scatterTargets)return;
  const w=visibleWidth(),h=visibleHeight();
  const columns=Math.ceil(Math.sqrt(count*w/h));
  const rows=Math.ceil(count/columns);
  const depthRange=7;
  for(let i=0;i<count;i++){
    const k=i*3,col=i%columns,row=Math.floor(i/columns);
    const z=(Math.random()-.5)*depthRange;
    const depthScale=(camera.position.z-z)/camera.position.z;
    const nx=(col+.12+Math.random()*.76)/columns-.5;
    const ny=(row+.12+Math.random()*.76)/rows-.5;
    scatterTargets[k]=nx*w*depthScale;
    scatterTargets[k+1]=ny*h*depthScale;
    scatterTargets[k+2]=z;
  }
}

// Rasterize the word once as a point cloud; particles themselves remain WebGL Points.
function buildWordTargets(targets,word){
  if(!targets)return;
  const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=300;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#fff';ctx.font='700 210px Arial, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(word,canvas.width*.5,canvas.height*.5);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data,cloud=[];
  for(let y=0;y<canvas.height;y+=3)for(let x=0;x<canvas.width;x+=3){
    if(pixels[(y*canvas.width+x)*4+3]>96)cloud.push(x/canvas.width,y/canvas.height);
  }
  const w=visibleWidth(),h=visibleHeight(),last=Math.max(0,cloud.length/2-1);
  for(let i=0;i<count;i++){
    const k=i*3,p=Math.min(last,Math.floor((i+.5)/count*cloud.length/2))*2;
    targets[k]=(cloud[p]-.5)*w*1.38;
    targets[k+1]=(.5-cloud[p+1])*h*.72;
    targets[k+2]=(seeds[i]-.5)*1.5;
  }
}
function buildHelloTargets(){buildWordTargets(helloTargets,'HELLO');}
function buildANSJTargets(){buildWordTargets(ansjTargets,'ANSJ');}
createParticles(count);

function mapScreen(nx, ny) { return { x: (nx-.5)*visibleWidth(), y: (.5-ny)*visibleHeight() }; }
function updatePointerPosition(clientX, clientY, now) {
  const rect = renderer.domElement.getBoundingClientRect();
  const nx = THREE.MathUtils.clamp((clientX-rect.left)/rect.width, 0, 1), ny = THREE.MathUtils.clamp((clientY-rect.top)/rect.height, 0, 1);
  const mapped = mapScreen(nx, ny), dt = Math.max(.008, (now-pointer.previousTime)/1000);
  pointer.vx = (mapped.x-pointer.x)/dt; pointer.vy = (mapped.y-pointer.y)/dt;
  pointer.x = mapped.x; pointer.y = mapped.y; pointer.previousTime = now; pointer.active = true;
}
renderer.domElement.addEventListener('pointermove', e => { if (!hand.detected) updatePointerPosition(e.clientX,e.clientY,performance.now()); });
renderer.domElement.addEventListener('pointerdown', e => { pointer.down=true; if (!hand.detected) updatePointerPosition(e.clientX,e.clientY,performance.now()); });
addEventListener('pointerup', () => { pointer.down=false; });
renderer.domElement.addEventListener('touchstart', e => { pointer.touches=e.touches.length; if(e.touches[0]&&!hand.detected)updatePointerPosition(e.touches[0].clientX,e.touches[0].clientY,performance.now()); }, {passive:true});
renderer.domElement.addEventListener('touchmove', e => { pointer.touches=e.touches.length; if(e.touches[0]&&!hand.detected)updatePointerPosition(e.touches[0].clientX,e.touches[0].clientY,performance.now()); }, {passive:true});
renderer.domElement.addEventListener('touchend', e => { pointer.touches=e.touches.length; }, {passive:true});

function updatePhysics(dt) {
  const step = Math.min(dt, .04), w=visibleWidth(), h=visibleHeight();
  const activeHand = hand.detected && performance.now()-hand.lastSeen < 650;
  const isHello = activeHand && hand.gesture==='HELLO';
  const isANSJ = activeHand && hand.gesture==='ANSJ';
  const usePointer = !activeHand && pointer.active;
  const interacting = (activeHand&&!isHello&&!isANSJ) || usePointer;
  const hx = activeHand ? (hand.gesture==='OPEN_HAND'||hand.gesture==='FIST'?hand.palmX:hand.x) : pointer.x;
  const hy = activeHand ? (hand.gesture==='OPEN_HAND'||hand.gesture==='FIST'?hand.palmY:hand.y) : pointer.y;
  const hvx = activeHand ? hand.vx : pointer.vx, hvy = activeHand ? hand.vy : pointer.vy;
  const isPinch = activeHand && hand.gesture==='PINCH' || usePointer && (pointer.down || pointer.touches>=2);
  const isOpen = activeHand && hand.gesture==='OPEN_HAND';
  const isFist = activeHand && hand.gesture==='FIST';
  const interactionRadius = visibleHeight() * CONFIG.INTERACTION_RADIUS;
  const radiusSq = interactionRadius*interactionRadius;
  const damping = Math.pow(CONFIG.DAMPING, step*60);
  if(isHello){helloRestore=1;ansjRestore=0;openRestore=0;}
  else if(isANSJ){ansjRestore=1;helloRestore=0;openRestore=0;}
  else {
    helloRestore*=Math.exp(-step*1.8);if(helloRestore<.008)helloRestore=0;
    ansjRestore*=Math.exp(-step*1.8);if(ansjRestore<.008)ansjRestore=0;
  }
  if(isOpen){openRestore=1;helloRestore=0;ansjRestore=0;}
  else {openRestore*=Math.exp(-step*.8);if(openRestore<.008)openRestore=0;}
  const restoreMix=openRestore>0?1-Math.exp(-step*CONFIG.OPEN_RESTORE_RATE*openRestore):0;
  const wordRestore=Math.max(helloRestore,ansjRestore);
  const wordTargets=helloRestore>=ansjRestore?helloTargets:ansjTargets;
  const wordMix=wordRestore>0?1-Math.exp(-step*4.5*wordRestore):0;
  const t = time;
  for (let i=0;i<count;i++) {
    const k=i*3, x=positions[k], y=positions[k+1], z=positions[k+2], seed=seeds[i];
    let ax=(Math.sin(y*.42 + t*.31 + seed*9)*Math.cos(z*.37-t*.19))*CONFIG.NOISE_STRENGTH;
    let ay=(Math.sin(z*.31 + t*.23 + seed*13)*Math.cos(x*.34+t*.17))*CONFIG.NOISE_STRENGTH;
    let az=(Math.sin(x*.19+y*.16+t*.13+seed*8))*CONFIG.NOISE_STRENGTH*.28;
    const distCenter=Math.sqrt(x*x+y*y), edge=Math.max(w,h)*.39;
    ax += -x/Math.max(1,distCenter)*Math.max(0,distCenter-edge)*.095;
    ay += -y/Math.max(1,distCenter)*Math.max(0,distCenter-edge)*.095;
    if (interacting) {
      const dx=x-hx, dy=y-hy, d2=dx*dx+dy*dy;
      if(d2<radiusSq*4){
        const d=Math.sqrt(d2)+.001, fall=1-THREE.MathUtils.smoothstep(interactionRadius*.08,interactionRadius*2,d);
        const speed=Math.min(2.7,Math.hypot(hvx,hvy)*.075), impulse=1+speed;
        const swirl=(isPinch?0.72:CONFIG.SWIRL_STRENGTH)*fall*impulse;
        ax += (-dy/d)*swirl; ay += (dx/d)*swirl;
        const attract=CONFIG.ATTRACTION_STRENGTH*fall*(isPinch||isOpen||isFist?0:CONFIG.POINT_ATTRACTION_MULTIPLIER);
        const repel=(isOpen?0:0.06)*fall;
        const radial=(repel-attract);
        ax += dx/d*radial + hvx*fall*.11; ay += dy/d*radial + hvy*fall*.11;
        const turb=Math.sin(seed*91+t*5+d*3)*CONFIG.TURBULENCE*fall;
        ax += turb; ay -= turb*.7;
        if(isPinch){
          const ringRadius=interactionRadius*CONFIG.PINCH_RING_RADIUS;
          const ringError=d-ringRadius;
          const ringForce=THREE.MathUtils.clamp(-ringError*CONFIG.PINCH_STRENGTH*1.55*fall,-4.2,4.2);
          ax += dx/d*ringForce;
          ay += dy/d*ringForce;
          az += THREE.MathUtils.clamp(-z*CONFIG.PINCH_STRENGTH*.8*fall,-2.8,2.8);
        }
      }
    }
    if(isFist){
      const dx=x-hand.palmX,dy=y-hand.palmY,dz=z,d=Math.hypot(dx,dy,dz)+.001;
      const ballRadius=visibleHeight()*CONFIG.FIST_BALL_RADIUS;
      const gatherRange=Math.hypot(w,h)*.72;
      const fall=1-THREE.MathUtils.smoothstep(gatherRange*.12,gatherRange,d);
      const shellForce=THREE.MathUtils.clamp(-(d-ballRadius)*CONFIG.FIST_PULL_STRENGTH*fall,-5,4);
      ax+=dx/d*shellForce;ay+=dy/d*shellForce;
      az+=dz/d*shellForce;
      const orbit=.48*fall;ax+=-dy/d*orbit;ay+=dx/d*orbit;
    }
    const interactionGain=interacting?(isOpen?2.5:isFist?2.2:isPinch?2.0:1.8):1;
    velocities[k] = (velocities[k]+ax*step*.31*interactionGain)*damping;
    velocities[k+1] = (velocities[k+1]+ay*step*.31*interactionGain)*damping;
    velocities[k+2] = (velocities[k+2]+az*step*.2*interactionGain)*damping;
    const maxV= (isOpen?2.3:isFist?1.8:isPinch?1.8:1.25) + (interacting?Math.min(1.8,Math.hypot(hvx,hvy)*.06):0);
    const v=Math.hypot(velocities[k],velocities[k+1]); if(v>maxV){const f=maxV/v;velocities[k]*=f;velocities[k+1]*=f;}
    positions[k] += velocities[k]*step*6; positions[k+1] += velocities[k+1]*step*6; positions[k+2] += velocities[k+2]*step*5;
    if(restoreMix>0){
      positions[k]+=(scatterTargets[k]-positions[k])*restoreMix;
      positions[k+1]+=(scatterTargets[k+1]-positions[k+1])*restoreMix;
      positions[k+2]+=(scatterTargets[k+2]-positions[k+2])*restoreMix;
      const retain=1-restoreMix*.86;
      velocities[k]*=retain;velocities[k+1]*=retain;velocities[k+2]*=retain;
    }
    if(wordMix>0){
      positions[k]+=(wordTargets[k]-positions[k])*wordMix;
      positions[k+1]+=(wordTargets[k+1]-positions[k+1])*wordMix;
      positions[k+2]+=(wordTargets[k+2]-positions[k+2])*wordMix;
      const retain=1-wordMix*.92;
      velocities[k]*=retain;velocities[k+1]*=retain;velocities[k+2]*=retain;
    }
    if(Math.abs(positions[k])>w*.62) velocities[k] += -Math.sign(positions[k])*.035;
    if(Math.abs(positions[k+1])>h*.62) velocities[k+1] += -Math.sign(positions[k+1])*.035;
    if(Math.abs(positions[k+2])>9) velocities[k+2] += -Math.sign(positions[k+2])*.025;
  }
  positionAttr.needsUpdate=true;
  points.material.uniforms.uTime.value=t;
  points.material.uniforms.uStart.value=spawnProgress;
  const interactionUniform=points.material.uniforms;
  interactionUniform.uInteraction.value.set(isOpen||isFist?hand.palmX:hx,isOpen||isFist?hand.palmY:hy);
  interactionUniform.uInteractionPower.value=interacting?1:0;
  interactionUniform.uInteractionRadius.value=interactionRadius*1.65;
}

function animate(now) {
  requestAnimationFrame(animate);
  const dt=Math.min(.05,(now-lastFrame)/1000); lastFrame=now; time+=dt;
  spawnProgress=Math.min(1,spawnProgress+dt/1.7);
  fpsFrames++;
  if(now-fpsStart>=600){currentFps=fpsFrames*1000/(now-fpsStart); fpsFrames=0; fpsStart=now; performanceAverage=performanceAverage*.8+currentFps*.2; adaptCount();}
  updatePhysics(dt);
  renderer.render(trailScene,trailCamera);
  renderer.render(scene,camera);
  if(!debugPanel.hidden) updateDebug();
}
function adaptCount(){
  let target=count;
  if(performanceAverage<43) target=Math.max(CONFIG.MIN_PARTICLES,Math.floor(count*.82));
  else if(performanceAverage>58 && count<CONFIG.MAX_PARTICLES) target=Math.min(CONFIG.MAX_PARTICLES,count+1000);
  if(target!==count) createParticles(target);
}
requestAnimationFrame(animate);

function resize(){
  camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,CONFIG.MAX_DPR)); renderer.setSize(innerWidth,innerHeight);
  trailMaterial.uniforms.alpha.value=CONFIG.TRAIL_ALPHA;
  if(positions){const w=visibleWidth(),h=visibleHeight();for(let i=0;i<count;i++){const k=i*3;positions[k]=THREE.MathUtils.clamp(positions[k],-w*.6,w*.6);positions[k+1]=THREE.MathUtils.clamp(positions[k+1],-h*.6,h*.6);}buildScatterTargets();buildHelloTargets();buildANSJTargets();positionAttr.needsUpdate=true;}
}
addEventListener('resize',resize);

function drawLandmarks(landmarks){
  if(landmarkCanvas.width!==cameraVideo.videoWidth){landmarkCanvas.width=cameraVideo.videoWidth||320;landmarkCanvas.height=cameraVideo.videoHeight||240;}
  landmarkCtx.clearRect(0,0,landmarkCanvas.width,landmarkCanvas.height);
  if(!debugButton.matches('[aria-pressed="true"]')||!landmarks)return;
  const w=landmarkCanvas.width,h=landmarkCanvas.height;
  const links=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
  landmarkCtx.strokeStyle='rgba(130,220,255,.75)';landmarkCtx.lineWidth=2;
  for(const [a,b] of links){landmarkCtx.beginPath();landmarkCtx.moveTo(landmarks[a].x*w,landmarks[a].y*h);landmarkCtx.lineTo(landmarks[b].x*w,landmarks[b].y*h);landmarkCtx.stroke();}
  landmarkCtx.fillStyle='#d8f7ff';for(const p of landmarks){landmarkCtx.beginPath();landmarkCtx.arc(p.x*w,p.y*h,2.2,0,Math.PI*2);landmarkCtx.fill();}
}
function classifyHand(lm){
  const tipThumb=lm[4],tipIndex=lm[8], palm=lm[9];
  const pinch=Math.hypot(tipThumb.x-tipIndex.x,tipThumb.y-tipIndex.y);
  const extended=(tip,mcp,wrist)=>Math.hypot(lm[tip].x-lm[wrist].x,lm[tip].y-lm[wrist].y)>Math.hypot(lm[mcp].x-lm[wrist].x,lm[mcp].y-lm[wrist].y)*1.16;
  const fingers=[extended(8,5,0),extended(12,9,0),extended(16,13,0),extended(20,17,0)];
  const openCount=fingers.filter(Boolean).length;
  const palmScale=Math.hypot(lm[0].x-lm[9].x,lm[0].y-lm[9].y);
  const thumbFolded=Math.hypot(lm[4].x-lm[9].x,lm[4].y-lm[9].y)<palmScale*1.25;
  const thumbExtended=Math.hypot(lm[4].x-lm[0].x,lm[4].y-lm[0].y)>Math.hypot(lm[2].x-lm[0].x,lm[2].y-lm[0].y)*1.32||!thumbFolded;
  const indexTipDistance=Math.hypot(lm[8].x-lm[0].x,lm[8].y-lm[0].y);
  const indexMcpDistance=Math.hypot(lm[5].x-lm[0].x,lm[5].y-lm[0].y);
  const indexPartlyExtended=indexTipDistance>indexMcpDistance*.96;
  let gesture='POINT';
  if(openCount>=4)gesture=thumbExtended?'OPEN_HAND':'ANSJ';
  else if(openCount===3)gesture='HELLO';
  else if(openCount===0&&thumbFolded&&!indexPartlyExtended)gesture='FIST';
  else if(pinch<.065&&indexPartlyExtended)gesture='PINCH';
  else if(openCount<=1&&!indexPartlyExtended&&thumbFolded)gesture='FIST';
  else if(openCount===0)gesture='FIST';
  return {pinch,gesture,palm};
}
function consumeLandmarks(lm,now){
  const {pinch,gesture,palm}=classifyHand(lm);
  const target=gesture==='PINCH'?{x:(lm[4].x+lm[8].x)*.5,y:(lm[4].y+lm[8].y)*.5}:gesture==='OPEN_HAND'||gesture==='FIST'?palm:lm[8];
  const index=mapScreen(1-target.x,target.y), center=mapScreen(1-palm.x,palm.y);
  const dt=Math.max(.008,(now-hand.lastSeen)/1000), smoothing=CONFIG.CAMERA_SMOOTHING;
  const oldX=hand.x,oldY=hand.y;
  if(!hand.detected){hand.x=index.x;hand.y=index.y;hand.vx=0;hand.vy=0;}
  else {hand.x=hand.x*smoothing+index.x*(1-smoothing);hand.y=hand.y*smoothing+index.y*(1-smoothing);hand.vx=(hand.x-oldX)/dt;hand.vy=(hand.y-oldY)/dt;}
  hand.palmX=center.x;hand.palmY=center.y;hand.detected=true;hand.lastSeen=now;hand.pinch=pinch;hand.gesture=gesture;
  if(pinchWasActive&&gesture!=='PINCH'){
    const nearest=hand.x, ny=hand.y;
    for(let i=0;i<count;i++){const k=i*3,dx=positions[k]-nearest,dy=positions[k+1]-ny,d=Math.hypot(dx,dy)+.01;if(d<visibleHeight()*.35){const f=CONFIG.EXPLOSION_STRENGTH*(1-d/(visibleHeight()*.35));velocities[k]+=dx/d*f;velocities[k+1]+=dy/d*f;}}
  }
  pinchWasActive=gesture==='PINCH';
  trackingEl.classList.add('active');trackingEl.innerHTML=`<i></i> HAND: ${gesture}`;
  gestureLabel.textContent=gesture==='POINT'?'INDEX FINGER — ATTRACT':gesture==='PINCH'?'PINCH — RING':gesture==='FIST'?'FIST — PARTICLE SPHERE':gesture==='HELLO'?'THREE FINGERS — HELLO':gesture==='ANSJ'?'FOUR FINGERS — ANSJ':'OPEN HAND — SCATTER';
  drawLandmarks(lm);
}
async function detectLoop(){
  if(!cameraVideo.srcObject)return;
  if((!handLandmarker&&!legacyHands)||cameraVideo.readyState<2||detectBusy){setTimeout(detectLoop,15);return;}
  detectBusy=true;
  try{
    const now=performance.now();
    if(handLandmarker){
      const result=handLandmarker.detectForVideo(cameraVideo,now);
      detectFailures=0;
      if(result.landmarks?.length)consumeLandmarks(result.landmarks[0],now);
      else resetHandIfMissing(now);
    }else if(legacyHands){
      await legacyHands.send({image:cameraVideo});
    }
  }catch(err){
    console.warn('Hand tracking frame failed',err);
    detectFailures++;
    if(detectFailures>=12){
      cameraError.hidden=false;
      cameraError.textContent=`CAMERA ON · TRACKING ERROR — ${err?.message||'RETRY HAND TRACKING'}`;
      cameraButton.disabled=false;cameraButton.textContent='TURN CAMERA OFF';
      trackingEl.classList.remove('active');handLandmarker?.close?.();handLandmarker=null;legacyHands?.close?.();legacyHands=null;
      detectBusy=false;return;
    }
  }
  detectBusy=false;setTimeout(detectLoop,24);
}
function resetHandIfMissing(now){
  if(now-hand.lastSeen>350){
    hand.detected=false;hand.gesture='IDLE';pinchWasActive=false;
    trackingEl.classList.remove('active');trackingEl.innerHTML='<i></i> HAND MODEL READY · SHOW HAND';
    gestureLabel.textContent='MOVE YOUR HAND TO INTERACT';drawLandmarks(null);
  }
}
function consumeLegacyResults(results){
  detectFailures=0;
  const landmarks=results.multiHandLandmarks?.[0];
  if(landmarks)consumeLandmarks(landmarks,performance.now());
  else resetHandIfMissing(performance.now());
}

function clearHandState(status='HAND TRACKING OFF'){
  hand.detected=false;hand.gesture='IDLE';hand.vx=0;hand.vy=0;pinchWasActive=false;
  trackingEl.classList.remove('active');trackingEl.innerHTML=`<i></i> ${status}`;
  gestureLabel.textContent='MOVE YOUR HAND TO INTERACT';drawLandmarks(null);
}

function stopCamera(message=''){
  cameraSession++;
  cameraStarting=false;
  detectBusy=false;
  handLandmarker?.close?.();handLandmarker=null;
  legacyHands?.close?.();legacyHands=null;
  const stream=cameraVideo.srcObject;
  if(stream)stream.getTracks().forEach(track=>track.stop());
  cameraVideo.pause();cameraVideo.srcObject=null;cameraWrap.hidden=true;
  clearHandState();
  cameraError.hidden=!message;
  if(message)cameraError.textContent=message;
  cameraButton.disabled=false;cameraButton.textContent='ENABLE CAMERA';
}

async function enableCamera(){
  if(cameraVideo.srcObject||cameraStarting){stopCamera();return;}
  const session=++cameraSession;
  cameraStarting=true;
  cameraButton.textContent='STARTING CAMERA';
  cameraButton.disabled=false;
  cameraError.hidden=true;

  let stream;
  {
    try{
      if(!navigator.mediaDevices?.getUserMedia){
        throw Object.assign(new Error('This browser does not expose camera access. Open localhost or HTTPS in a full browser.'),{name:'CameraUnavailableError'});
      }
      const cameraPromise=navigator.mediaDevices.getUserMedia({
        video:{facingMode:'user',width:{ideal:640},height:{ideal:480}},
        audio:false,
      });
      let cameraTimer;
      const cameraTimeout=new Promise((_,reject)=>{
        cameraTimer=setTimeout(()=>reject(Object.assign(
          new Error('No camera response. Allow camera access for this site, or open localhost in a full browser.'),
          {name:'CameraTimeoutError'},
        )),15000);
      });
      try{
        stream=await Promise.race([cameraPromise,cameraTimeout]);
        clearTimeout(cameraTimer);
      }catch(error){
        clearTimeout(cameraTimer);
        if(error.name==='CameraTimeoutError'){
          cameraPromise.then(lateStream=>lateStream.getTracks().forEach(track=>track.stop())).catch(()=>{});
        }
        throw error;
      }
      if(session!==cameraSession){stream.getTracks().forEach(track=>track.stop());return;}
      cameraVideo.srcObject=stream;
      await cameraVideo.play();
      if(session!==cameraSession){stream.getTracks().forEach(track=>track.stop());return;}
      cameraWrap.hidden=false;
      stream.getVideoTracks()[0]?.addEventListener('ended',()=>{
        if(cameraVideo.srcObject===stream)stopCamera('CAMERA STREAM ENDED — RECONNECT THE CAMERA');
      });
    }catch(error){
      if(session!==cameraSession)return;
      console.error('Camera startup failed:',error);
      cameraStarting=false;
      cameraButton.disabled=false;
      cameraButton.textContent='ENABLE CAMERA';
      cameraError.hidden=false;
      const messages={
        NotAllowedError:'CAMERA BLOCKED — ALLOW CAMERA FOR LOCALHOST IN BROWSER SETTINGS',
        PermissionDeniedError:'CAMERA BLOCKED — ALLOW CAMERA FOR LOCALHOST IN BROWSER SETTINGS',
        NotFoundError:'NO CAMERA FOUND',
        NotReadableError:'CAMERA IS IN USE BY ANOTHER APP',
        CameraUnavailableError:error.message,
        SecurityError:'CAMERA REQUIRES HTTPS OR LOCALHOST',
        CameraTimeoutError:'CAMERA REQUEST TIMED OUT — OPEN THIS PAGE IN CHROME / SAFARI AND ALLOW CAMERA',
      };
      cameraError.textContent=messages[error?.name]||`CAMERA START FAILED — ${error?.message||'CHECK CAMERA PERMISSION'}`;
      return;
    }
  }

  try{
    await initializeHandTracking(session);
    if(session!==cameraSession){handLandmarker?.close?.();handLandmarker=null;legacyHands?.close?.();legacyHands=null;return;}
    cameraStarting=false;
    cameraButton.disabled=false;cameraButton.textContent='TURN CAMERA OFF';
  }catch(error){
    if(session!==cameraSession)return;
    console.error('Hand tracking initialization failed; camera remains active:',error);
    cameraStarting=false;
    cameraButton.disabled=false;
    cameraButton.textContent='TURN CAMERA OFF';
    cameraError.hidden=false;
  cameraError.textContent=`CAMERA ON · HAND MODEL FAILED — ${error?.message||'CHECK INTERNET ACCESS AND RETRY'}`;
  }
}

async function initializeHandTracking(session){
  try{
    await initializeTasksHandTracking(session);
  }catch(tasksError){
    if(session!==cameraSession)return;
    console.warn('Tasks Vision initialization failed; trying MediaPipe Hands:',tasksError);
    handLandmarker?.close?.();handLandmarker=null;
    await initializeLegacyHands(tasksError,session);
  }
}

async function initializeTasksHandTracking(session){
  cameraButton.disabled=false;cameraButton.textContent='LOADING MODEL · TURN OFF';cameraError.hidden=true;
  await loadVisionBundle();
  if(session!==cameraSession)return;
  const FilesetResolver=globalThis.FilesetResolver||globalThis.vision?.FilesetResolver;
  const HandLandmarker=globalThis.HandLandmarker||globalThis.vision?.HandLandmarker;
  if(!FilesetResolver||!HandLandmarker) throw new Error('MediaPipe bundle loaded without its API. Check the browser console and retry.');
  const files=await Promise.race([
    FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm'),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('MediaPipe runtime download timed out. Check internet access and retry.')),25000)),
  ]);
  if(session!==cameraSession)return;
  const options={baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'},runningMode:'VIDEO',numHands:1,minHandDetectionConfidence:.55,minHandPresenceConfidence:.5,minTrackingConfidence:.5};
  try { handLandmarker=await HandLandmarker.createFromOptions(files,{...options,baseOptions:{...options.baseOptions,delegate:'GPU'}}); }
  catch (gpuError) {
    if(session!==cameraSession)return;
    console.warn('MediaPipe GPU delegate failed; retrying CPU:',gpuError);
    handLandmarker=await HandLandmarker.createFromOptions(files,{...options,baseOptions:{...options.baseOptions,delegate:'CPU'}});
  }
  if(session!==cameraSession){handLandmarker?.close?.();handLandmarker=null;return;}
  cameraButton.textContent='TURN CAMERA OFF';cameraButton.disabled=false;trackingEl.classList.remove('active');trackingEl.innerHTML='<i></i> HAND MODEL READY · SHOW HAND';
  detectLoop();
}

async function initializeLegacyHands(tasksError,session){
  await loadLegacyHandsBundle();
  if(session!==cameraSession)return;
  const Hands=globalThis.Hands;
  if(!Hands)throw new Error(`Both hand runtimes failed. Tasks Vision: ${tasksError?.message||'unavailable'}. MediaPipe Hands API is missing.`);
  legacyHands=new Hands({locateFile:file=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`});
  await legacyHands.setOptions({maxNumHands:1,modelComplexity:1,minDetectionConfidence:.55,minTrackingConfidence:.5});
  if(session!==cameraSession){legacyHands.close?.();legacyHands=null;return;}
  legacyHands.onResults(consumeLegacyResults);
  cameraButton.textContent='TURN CAMERA OFF';cameraButton.disabled=false;
  trackingEl.classList.remove('active');trackingEl.innerHTML='<i></i> HAND MODEL READY · SHOW HAND';
  detectLoop();
}

async function loadLegacyHandsBundle(){
  if(globalThis.Hands)return;
  await new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js';
    script.crossOrigin='anonymous';
    const timeout=setTimeout(()=>{script.remove();reject(new Error('MediaPipe Hands fallback download timed out.'));},25000);
    script.onload=()=>{clearTimeout(timeout);resolve();};
    script.onerror=()=>{clearTimeout(timeout);reject(new Error('Could not download the MediaPipe Hands fallback.'));};
    document.head.appendChild(script);
  });
}

async function loadVisionBundle(){
  if(globalThis.FilesetResolver||globalThis.vision?.FilesetResolver)return;
  const existing=document.querySelector('script[data-mediapipe-vision]');
  if(existing){
    await new Promise((resolve,reject)=>{
      if(existing.dataset.loaded==='true'){resolve();return;}
      existing.addEventListener('load',resolve,{once:true});
      existing.addEventListener('error',()=>reject(new Error('Could not download MediaPipe. Check internet access and retry.')),{once:true});
    });
    return;
  }
  await new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/vision_bundle.mjs';
    script.crossOrigin='anonymous';
    script.dataset.mediapipeVision='true';
    const timeout=setTimeout(()=>{script.remove();reject(new Error('MediaPipe download timed out. Check internet access and retry.'));},25000);
    script.onload=()=>{clearTimeout(timeout);script.dataset.loaded='true';resolve();};
    script.onerror=()=>{clearTimeout(timeout);script.remove();reject(new Error('Could not download MediaPipe from jsDelivr. Check internet access and retry.'));};
    document.head.appendChild(script);
  });
}
cameraButton.addEventListener('click',enableCamera);
debugButton.addEventListener('click',()=>{const enabled=debugButton.getAttribute('aria-pressed')!=='true';debugButton.setAttribute('aria-pressed',String(enabled));debugPanel.hidden=!enabled;if(!enabled)drawLandmarks(null);});
function updateDebug(){debugPanel.textContent=`FPS                 ${currentFps.toFixed(1)}\nPARTICLES           ${count.toLocaleString()}\nHAND DETECTED       ${hand.detected?'YES':'NO'}\nGESTURE             ${hand.detected?hand.gesture:'IDLE'}\nFINGER              ${hand.detected?`${(hand.x/visibleWidth()+.5).toFixed(2)}, ${(0.5-hand.y/visibleHeight()).toFixed(2)}`:'—'}\nPINCH DISTANCE       ${hand.detected?hand.pinch.toFixed(3):'—'}\nINTERACTION RADIUS   ${CONFIG.INTERACTION_RADIUS.toFixed(2)}`;}
