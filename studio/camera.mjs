// 相机求解（M4）。纯 JS，无 OpenCV 依赖：
// DLT（Jacobi 特征分解）求初始投影矩阵 → RQ 分解出 K,R,t → 高斯牛顿精化重投影。
// 证据不足时只能得到“估计”：调用方必须把结果标记为待人工确认（计划 A5）。

// ---- 小型线性代数 ----
export function matVec(A, x) {return A.map(row => row.reduce((sum, value, j) => sum + value * x[j], 0));}
export function transpose(A) {return A[0].map((_, j) => A.map(row => row[j]));}
export function matMul(A, B) {return A.map(row => B[0].map((_, j) => row.reduce((sum, value, k) => sum + value * B[k][j], 0)));}
export function rotationMatrix(axis, angle) {
  const [x, y, z] = axis, c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
export function rotationVectorFromMatrix(R) {
  const angle = Math.acos(Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2)));
  if (!Number.isFinite(angle) || angle < 1e-9) return [0, 0, 0];
  const axis = [(R[2][1] - R[1][2]) / (2 * Math.sin(angle)), (R[0][2] - R[2][0]) / (2 * Math.sin(angle)), (R[1][0] - R[0][1]) / (2 * Math.sin(angle))];
  return axis.map(value => value * angle);
}
export function matrixFromRotationVector(omega) {
  const angle = Math.hypot(...omega);
  if (angle < 1e-9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return rotationMatrix(omega.map(value => value / angle), angle);
}

// 对称矩阵 Jacobi 特征分解：返回 {values, vectors}（升序）。
export function jacobiEigen(input, {sweeps = 60} = {}) {
  const n = input.length;
  const A = input.map(row => [...row]);
  const V = Array.from({length: n}, (_, i) => Array.from({length: n}, (_, j) => i === j ? 1 : 0));
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-15) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = A[k][p], akq = A[k][q];
        A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p][k], aqk = A[q][k];
        A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        const vpk = V[k][p], vqk = V[k][q];
        V[k][p] = c * vpk - s * vqk; V[k][q] = s * vpk + c * vqk;
      }
    }
  }
  const pairs = A.map((row, i) => ({value: row[i], vector: V.map(rowV => rowV[i])})).sort((a, b) => a.value - b.value);
  return {values: pairs.map(pair => pair.value), vectors: pairs.map(pair => pair.vector)};
}

// ---- DLT：3D↔2D 对应（≥6 对）→ 3×4 投影矩阵 ----
export function dlt(correspondences) {
  if (correspondences.length < 6) throw Object.assign(new Error('DLT 至少需要 6 个 3D–2D 对应点'), {status: 422});
  // Hartley 归一化
  const centroid3 = [0, 1, 2].map(dimension => correspondences.reduce((sum, c) => sum + c.X[dimension], 0) / correspondences.length);
  const meanDist3 = correspondences.reduce((sum, c) => sum + Math.hypot(c.X[0] - centroid3[0], c.X[1] - centroid3[1], c.X[2] - centroid3[2]), 0) / correspondences.length;
  const s3 = Math.SQRT2 / (meanDist3 || 1);
  const centroid2 = [0, 1].map(dimension => correspondences.reduce((sum, c) => sum + c.x[dimension], 0) / correspondences.length);
  const meanDist2 = correspondences.reduce((sum, c) => sum + Math.hypot(c.x[0] - centroid2[0], c.x[1] - centroid2[1]), 0) / correspondences.length;
  const s2 = Math.SQRT2 / (meanDist2 || 1);
  const normalize3 = X => [(X[0] - centroid3[0]) * s3, (X[1] - centroid3[1]) * s3, (X[2] - centroid3[2]) * s3];
  const normalize2 = x => [(x[0] - centroid2[0]) * s2, (x[1] - centroid2[1]) * s2];
  const rows = [];
  for (const {X, x} of correspondences) {
    const [Xn, Yn, Zn] = normalize3(X);
    const [un, vn] = normalize2(x);
    rows.push([Xn, Yn, Zn, 1, 0, 0, 0, 0, -un * Xn, -un * Yn, -un * Zn, -un]);
    rows.push([0, 0, 0, 0, Xn, Yn, Zn, 1, -vn * Xn, -vn * Yn, -vn * Zn, -vn]);
  }
  // AᵀA 的最小特征向量 = P（12 维）
  const AtA = Array.from({length: 12}, (_, i) => Array.from({length: 12}, (_, j) => rows.reduce((sum, row) => sum + row[i] * row[j], 0)));
  const {vectors} = jacobiEigen(AtA);
  const pFlat = vectors[0];
  const Pn = [0, 1, 2].map(i => pFlat.slice(i * 4, i * 4 + 4));
  // 反归一化：x = T2⁻¹ · Pn · (T3 · X) → P = T2⁻¹ · Pn · T3
  const T2inv = [[1 / s2, 0, centroid2[0]], [0, 1 / s2, centroid2[1]], [0, 0, 1]];
  const T3 = [[s3, 0, 0, -s3 * centroid3[0]], [0, s3, 0, -s3 * centroid3[1]], [0, 0, s3, -s3 * centroid3[2]], [0, 0, 0, 1]];
  const P = matMul(T2inv, matMul(Pn, T3));
  return P.map(row => row.map(value => {
    if (!Number.isFinite(value)) throw Object.assign(new Error('DLT 数值发散：请检查对应点（避免共面退化或坐标错误）'), {status: 422});
    return value;
  }));
}

// ---- QR（Householder，方阵满秩）与 RQ 分解（scipy.linalg.rq 配方）----
function qrHouseholder(A) {
  const m = A.length, n = A[0].length;
  const R = A.map(row => [...row]);
  const Q = Array.from({length: m}, (_, i) => Array.from({length: m}, (_, j) => i === j ? 1 : 0));
  for (let k = 0; k < Math.min(m - 1, n); k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += R[i][k] * R[i][k];
    norm = Math.sqrt(norm);
    if (norm < 1e-15) continue;
    const v = new Array(m).fill(0);
    const alpha = R[k][k] > 0 ? -norm : norm;
    v[k] = R[k][k] - alpha;
    for (let i = k + 1; i < m; i++) v[i] = R[i][k];
    const vNorm2 = v.reduce((sum, value) => sum + value * value, 0);
    if (vNorm2 < 1e-30) continue;
    for (let j = 0; j < n; j++) {
      const dot = v.reduce((sum, value, i) => sum + value * R[i][j], 0) / vNorm2;
      for (let i = 0; i < m; i++) R[i][j] -= 2 * dot * v[i];
    }
    // Q ← Q·Hₖ（反射器从右侧累积，使最终 Q = H₁H₂⋯ 且 R = QᵀA）
    for (let i = 0; i < m; i++) {
      const dot = v.reduce((sum, value, j) => sum + value * Q[i][j], 0) / vNorm2;
      for (let j = 0; j < m; j++) Q[i][j] -= 2 * dot * v[j];
    }
  }
  return {Q, R};
}

// M = K·R（K 上三角、R 旋转）。
// 推导：Mᵀ = Rᵀ·Kᵀ 是 Mᵀ 的 QL 分解；QL(X) = J·(QR(J·X·J))：对 X 的 180° 旋转做 QR，
// 再把两个因子各自 180° 转回。旋转矩阵 J 表示行列同时反转（J²=I）。
const rot180 = m => m.map(row => [...row].reverse()).reverse();
export function rqDecomposition(M) {
  const X = transpose(M);
  const {Q: Qtilde, R: Rtilde} = qrHouseholder(rot180(X));
  const L = rot180(Rtilde); // 下三角
  const Q = rot180(Qtilde);
  const K = transpose(L);   // 上三角
  const Rot = transpose(Q);
  // 符号修正：取反 K 的列 i 与 R 的行 i（乘积不变），使 diag(K) > 0。
  for (let i = 0; i < K.length; i++) {
    if (K[i][i] < 0) {
      for (let r = 0; r < K.length; r++) K[r][i] = -K[r][i];
      for (let j = 0; j < Rot.length; j++) Rot[i][j] = -Rot[i][j];
    }
  }
  return {K, R: Rot};
}

export function projectPoints(intrinsics, R, t, points) {
  const {fx, fy, cx, cy} = intrinsics;
  return points.map(X => {
    const Xc = [R[0][0] * X[0] + R[0][1] * X[1] + R[0][2] * X[2] + t[0],
      R[1][0] * X[0] + R[1][1] * X[1] + R[1][2] * X[2] + t[1],
      R[2][0] * X[0] + R[2][1] * X[1] + R[2][2] * X[2] + t[2]];
    if (Xc[2] <= 1e-6) return null;
    return [fx * Xc[0] / Xc[2] + cx, fy * Xc[1] / Xc[2] + cy];
  });
}

// 完整求解：DLT 初始 → 尺度/符号选择（det(R)>0 且深度为正）→ RQ 分解 → 高斯牛顿精化。
export function solveCamera({correspondences, refine = true, maxIterations = 60}) {
  if (correspondences.length < 6) throw Object.assign(new Error('相机求解至少需要 6 个地标对应；证据不足时应保持待人工确认'), {status: 422});
  const P = dlt(correspondences);
  const M = [P[0].slice(0, 3), P[1].slice(0, 3), P[2].slice(0, 3)];
  const p4 = [P[0][3], P[1][3], P[2][3]];
  const row3Norm = Math.hypot(M[2][0], M[2][1], M[2][2]);
  if (!(row3Norm > 1e-12)) throw Object.assign(new Error('DLT 退化：第三行范数为 0'), {status: 422});
  let chosen = null;
  for (const sign of [1, -1]) {
    const rho = sign / row3Norm;
    const {K: K0, R: R0} = rqDecomposition(M.map(row => row.map(value => value * rho)));
    const det = R0[0][0] * (R0[1][1] * R0[2][2] - R0[1][2] * R0[2][1]) - R0[0][1] * (R0[1][0] * R0[2][2] - R0[1][2] * R0[2][0]) + R0[0][2] * (R0[1][0] * R0[2][1] - R0[1][1] * R0[2][0]);
    if (det <= 0) continue;
    // P_norm = [K·R | K·t] → t = K⁻¹·(ρ·p4)（上三角回代）
    const b = p4.map(value => value * rho);
    const t0 = new Array(3).fill(0);
    for (let i = K0.length - 1; i >= 0; i--) {
      let sum = 0;
      for (let j = i + 1; j < K0.length; j++) sum += K0[i][j] * t0[j];
      t0[i] = (b[i] - sum) / K0[i][i];
    }
    const depths = correspondences.map(({X}) => R0[2][0] * X[0] + R0[2][1] * X[1] + R0[2][2] * X[2] + t0[2]);
    depths.sort((a, b) => a - b);
    const medianDepth = depths[depths.length >> 1];
    if (medianDepth <= 0) continue;
    chosen = {K0, R0, t0};
    break;
  }
  if (!chosen) throw Object.assign(new Error('相机分解退化：地标可能共面或坐标有误'), {status: 422});
  const {K0, R0, t0} = chosen;
  if (!(K0[0][0] > 0 && K0[1][1] > 0 && K0[2][2] > 0)) throw Object.assign(new Error('相机内参符号异常'), {status: 422});
  let params = [K0[0][0], K0[1][1], K0[0][2], K0[1][2], ...rotationVectorFromMatrix(R0), ...t0];
  if (refine) params = gaussNewton(params, correspondences, maxIterations);
  return packSolution(params, correspondences);
}

const pack = params => ({
  intrinsics: {fx: params[0], fy: params[1], cx: params[2], cy: params[3]},
  R: matrixFromRotationVector(params.slice(4, 7)),
  t: params.slice(7, 10),
});

function residuals(params, correspondences) {
  const {intrinsics, R, t} = pack(params);
  const projected = projectPoints(intrinsics, R, t, correspondences.map(c => c.X));
  return correspondences.map((c, index) => projected[index] ? [projected[index][0] - c.x[0], projected[index][1] - c.x[1]] : [1e3, 1e3]);
}

function gaussNewton(params, correspondences, maxIterations) {
  let current = [...params];
  let lastCost = Infinity;
  const eps = 1e-5;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const flat = residuals(current, correspondences).flat(); // 2n
    const cost = flat.reduce((sum, value) => sum + value * value, 0);
    if (lastCost - cost < 1e-9) break;
    lastCost = cost;
    // 数值雅可比：Jcols[p] = ∂flat/∂param[p]；正规方程 (JᵀJ + λI)·delta = Jᵀ·r
    const Jcols = [];
    for (let p = 0; p < current.length; p++) {
      const perturbed = [...current];perturbed[p] += eps;
      const rflat = residuals(perturbed, correspondences).flat();
      Jcols.push(rflat.map((value, i) => (value - flat[i]) / eps));
    }
    const n = current.length;
    const JTJ = Array.from({length: n}, (_, p) => Array.from({length: n}, (_, q) => Jcols[p].reduce((sum, value, i) => sum + value * Jcols[q][i], 0)));
    const JTr = Jcols.map(col => col.reduce((sum, value, i) => sum + value * flat[i], 0));
    for (let p = 0; p < n; p++) JTJ[p][p] += 1e-9 * (JTJ[p][p] || 1);
    const delta = solveLinear(JTJ, JTr);
    if (!delta || delta.some(value => !Number.isFinite(value))) break;
    current = current.map((value, index) => value - (delta[index] || 0));
  }
  return current;
}

function matMulNum(A, B) {return A.map(row => B[0].map((_, j) => row.reduce((sum, value, k) => sum + value * B[k][j], 0)));}
function solveLinear(A, b) {
  const {vectors, values} = jacobiEigen(A);
  const maxEigen = Math.max(...values.map(Math.abs));
  if (maxEigen < 1e-12) return null;
  // 截断小特征值（正则化最小二乘）
  const y = vectors.map(vector => vector.reduce((sum, value, index) => sum + value * b[index], 0));
  const solution = new Array(A.length).fill(0);
  vectors.forEach((vector, eigenIndex) => {
    if (Math.abs(values[eigenIndex]) < maxEigen * 1e-8) return;
    const coefficient = y[eigenIndex] / values[eigenIndex];
    for (let i = 0; i < A.length; i++) solution[i] += coefficient * vector[i];
  });
  return solution;
}

function packSolution(params, correspondences) {
  const {intrinsics, R, t} = pack(params);
  const projected = projectPoints(intrinsics, R, t, correspondences.map(c => c.X));
  const perPoint = correspondences.map((c, index) => {
    if (!projected[index]) return {errorPx: NaN};
    return {errorPx: Number(Math.hypot(projected[index][0] - c.x[0], projected[index][1] - c.x[1]).toFixed(2))};
  });
  const errors = perPoint.map(point => point.errorPx).filter(Number.isFinite).sort((a, b) => a - b);
  const median = errors.length ? (errors.length % 2 ? errors[(errors.length - 1) / 2] : (errors[errors.length / 2 - 1] + errors[errors.length / 2]) / 2) : NaN;
  const medianErrorPx = Number(median.toFixed(2));
  // A5 语义：中位重投影 ≤8px 且 ≥6 点 → 高置信；否则标记为待人工确认。
  const confidence = Number.isFinite(medianErrorPx) && medianErrorPx <= 8 && correspondences.length >= 6 ? 0.8 : 0.3;
  return {
    intrinsics: {fx: intrinsics.fx, fy: intrinsics.fy, cx: intrinsics.cx, cy: intrinsics.cy},
    extrinsics: {rotation: R.flat(), translation: t},
    medianErrorPx,
    perPointErrors: perPoint,
    confidence,
    needsManualReview: medianErrorPx > 8,
  };
}

// 证据不足时的兜底：由人物框推一个粗略距离估计（必须显示为“估计/待人工确认”）。
export function estimateCameraFromPersonBox({box, imageWidth, imageHeight, assumedHeight = 1.75, assumedFovDegrees = 55}) {
  if (!box || box.h <= 0) throw Object.assign(new Error('人物框无效'), {status: 400});
  const focalPx = (Math.max(imageWidth, imageHeight) / 2) / Math.tan((assumedFovDegrees / 2) * Math.PI / 180);
  const boxHeightPx = box.h * imageHeight;
  const distance = focalPx * assumedHeight / boxHeightPx;
  return {
    source: 'person-estimate',
    intrinsics: {fx: focalPx, fy: focalPx, cx: imageWidth / 2, cy: imageHeight / 2},
    distanceMeters: Number(distance.toFixed(2)),
    assumptions: {personHeight: assumedHeight, fovDegrees: assumedFovDegrees},
    confidence: 0.2,
    needsManualReview: true,
  };
}
