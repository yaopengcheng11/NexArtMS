"""Run only in disposable Blender --background --factory-startup processes.
Usage: blender --background --factory-startup --python scripts/dcc-probe.py -- glb
Other modes: blend, fbx, usd. Reports are independent, never overwrite user scenes.
"""
import bpy
import json
import math
import sys
from pathlib import Path
from datetime import datetime, timezone
from mathutils import Quaternion

BASE = Path(__file__).resolve().parents[1]
MODE = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'glb'
OUT = BASE / 'public' / 'probes' / 'dcc'
REPORTS = BASE / 'reports'
OUT.mkdir(parents=True, exist_ok=True)
REPORTS.mkdir(parents=True, exist_ok=True)
REPORT = {
    'schemaVersion': 1, 'probe': 'M0 real GLB skeleton / Blender import and interchange',
    'mode': MODE, 'generatedAt': datetime.now(timezone.utc).isoformat(),
    'environment': {'blenderVersion': bpy.app.version_string, 'background': bpy.app.background},
    'checks': {}, 'exports': {}, 'status': 'failed',
    'limitations': ['Synthetic forearm animation only, not source-video motion.',
                    'This does not validate Maya or Houdini; both remain unverified.',
                    'No camera or scene reconstruction quality is evaluated by this character fixture.'],
    'targetSoftware': {'Blender': 'running', 'Maya': 'unverified / unavailable', 'Houdini': 'unverified / unavailable'},
}

PARENTS = {
    'root': None, 'pelvis': 'root', 'spine': 'pelvis', 'chest': 'spine', 'neck': 'chest', 'head': 'neck',
    'shoulder_L': 'chest', 'upperArm_L': 'shoulder_L', 'forearm_L': 'upperArm_L', 'hand_L': 'forearm_L',
    'shoulder_R': 'chest', 'upperArm_R': 'shoulder_R', 'forearm_R': 'upperArm_R', 'hand_R': 'forearm_R',
    'thigh_L': 'pelvis', 'shin_L': 'thigh_L', 'foot_L': 'shin_L', 'toe_L': 'foot_L',
    'thigh_R': 'pelvis', 'shin_R': 'thigh_R', 'foot_R': 'shin_R', 'toe_R': 'foot_R',
}

def semantic(name):
    return name.split('__')[-1]

def points(obj):
    deps = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(deps)
    mesh = evaluated.to_mesh()
    result = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
    evaluated.to_mesh_clear()
    return result

def action_ranges():
    return [{'name': a.name, 'frameRange': list(a.frame_range)} for a in bpy.data.actions]

def validate_scene():
    armatures = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    REPORT['checks']['objects'] = {'armatures': len(armatures), 'meshes': len(meshes), 'objectNames': [o.name for o in bpy.context.scene.objects]}
    if len(armatures) != 1 or not meshes:
        raise RuntimeError('Expected exactly one armature and at least one mesh')
    armature = armatures[0]
    custom_shapes = {bone.custom_shape for bone in armature.pose.bones if bone.custom_shape}
    REPORT['checks']['objects']['importerBoneDisplayHelpers'] = [o.name for o in meshes if o in custom_shapes]
    meshes = [o for o in meshes if o not in custom_shapes]
    by_id = {semantic(b.name): b for b in armature.data.bones}
    hierarchy_errors = []
    for name, expected_parent in PARENTS.items():
        bone = by_id.get(name)
        if bone is None:
            hierarchy_errors.append('missing: ' + name)
        else:
            actual_parent = semantic(bone.parent.name) if bone.parent else None
            if actual_parent != expected_parent:
                hierarchy_errors.append(f'{name}: parent {actual_parent} expected {expected_parent}')
    REPORT['checks']['skeleton'] = {'boneCount': len(armature.data.bones), 'jointIds': list(by_id), 'hierarchyErrors': hierarchy_errors,
                                   'hasRestPose': all(len(b.matrix_local) == 4 for b in armature.data.bones)}
    if len(by_id) != 22 or hierarchy_errors:
        raise RuntimeError('Skeleton topology changed')
    invalid_weights = 0
    total_vertices = 0
    modifiers = []
    for mesh in meshes:
        armature_modifiers = [m for m in mesh.modifiers if m.type == 'ARMATURE' and m.object == armature]
        modifiers.append({'mesh': mesh.name, 'armatureModifiers': len(armature_modifiers)})
        if not armature_modifiers:
            raise RuntimeError('Mesh has no armature binding: ' + mesh.name)
        group_names = {g.index: semantic(g.name) for g in mesh.vertex_groups}
        for vertex in mesh.data.vertices:
            total_vertices += 1
            influences = [(group_names.get(g.group), g.weight) for g in vertex.groups if g.weight > 1e-6]
            if len(influences) != 1 or influences[0][0] not in PARENTS or abs(influences[0][1] - 1) > 1e-6:
                invalid_weights += 1
    REPORT['checks']['binding'] = {'vertices': total_vertices, 'invalidSingleBoneWeights': invalid_weights, 'modifiers': modifiers}
    if invalid_weights:
        raise RuntimeError('Binding is not rigid single-bone unit weight')
    ranges = action_ranges()
    REPORT['checks']['animation'] = {'actions': ranges, 'fps': bpy.context.scene.render.fps, 'fpsBase': bpy.context.scene.render.fps_base}
    # Check actual evaluated motion at three source clip times; endpoint may return to its start.
    if ranges:
        start = min(a['frameRange'][0] for a in ranges)
        end = max(a['frameRange'][1] for a in ranges)
        samples = [start, (start + end) / 2, end]
        hand_samples = []
        for frame in samples:
            bpy.context.scene.frame_set(int(frame), subframe=frame % 1)
            pbone = armature.pose.bones[by_id['hand_L'].name]
            hand_samples.append((armature.matrix_world @ pbone.matrix).translation.copy())
        max_displacement = max((p - hand_samples[0]).length for p in hand_samples)
        REPORT['checks']['animation'].update({'sampleFrames': samples, 'handPositions': [list(p) for p in hand_samples], 'maxHandDisplacementMeters': max_displacement, 'playableMotion': max_displacement > .001})
        if max_displacement <= .001:
            raise RuntimeError('Expected synthetic elbow animation did not move the hand')
    else:
        REPORT['checks']['animation']['playableMotion'] = False
        raise RuntimeError('Animation missing')
    # Temporarily detach clip; rotate one imported elbow and compare affected/invariant vertices.
    bpy.context.scene.frame_set(1)
    animation_data = armature.animation_data
    previous_action = animation_data.action if animation_data else None
    previous_slot = animation_data.action_slot if animation_data else None
    if animation_data:
        animation_data.action = None
    elbow = armature.pose.bones[by_id['forearm_L'].name]
    saved_matrix = elbow.matrix_basis.copy()
    saved_mode = elbow.rotation_mode
    before = {mesh.name: points(mesh) for mesh in meshes}
    elbow.rotation_mode = 'QUATERNION'
    elbow.rotation_quaternion = elbow.rotation_quaternion @ Quaternion((0, 0, 1), math.pi / 3)
    bpy.context.view_layer.update()
    affected_max = 0
    invariant_max = 0
    affected_count = 0
    for mesh in meshes:
        after = points(mesh)
        groups = {g.index: semantic(g.name) for g in mesh.vertex_groups}
        for vertex in mesh.data.vertices:
            owner = next((groups.get(g.group) for g in vertex.groups if g.weight > .99), None)
            delta = (after[vertex.index] - before[mesh.name][vertex.index]).length
            if owner in ('forearm_L', 'hand_L'):
                affected_max = max(affected_max, delta)
                affected_count += 1
            else:
                invariant_max = max(invariant_max, delta)
    elbow.matrix_basis = saved_matrix
    elbow.rotation_mode = saved_mode
    if animation_data:
        animation_data.action = previous_action
        if previous_slot:
            animation_data.action_slot = previous_slot
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    restored = {mesh.name: points(mesh) for mesh in meshes}
    restored_error = max((restored[mesh.name][v.index] - before[mesh.name][v.index]).length for mesh in meshes for v in mesh.data.vertices)
    REPORT['checks']['manualElbowRotation'] = {'affectedVertices': affected_count, 'affectedMaxDisplacementMeters': affected_max,
                                                'unaffectedMaxDisplacementMeters': invariant_max, 'restoredMaxErrorMeters': restored_error,
                                                'passed': affected_max > .001 and invariant_max < 1e-5 and restored_error < 1e-5}
    if not REPORT['checks']['manualElbowRotation']['passed']:
        raise RuntimeError('Manual joint rotation failed rigid attachment/isolation/restoration check')
    return armature, meshes


def export_if_supported(format_name, operator, requested):
    props = {p.identifier for p in operator.get_rna_type().properties}
    args = {key: value for key, value in requested.items() if key in props}
    try:
        result = operator(**args)
        path = Path(args['filepath'])
        REPORT['exports'][format_name] = {'status': 'exported-awaiting-independent-reimport', 'operatorResult': list(result), 'options': args,
                                          'path': str(path), 'bytes': path.stat().st_size if path.exists() else 0}
    except Exception as error:
        REPORT['exports'][format_name] = {'status': 'failed', 'error': str(error), 'options': args}

try:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source = BASE / 'public' / 'probes' / 'rig.glb' if MODE == 'glb' else OUT / ('rig.' + {'blend': 'blend', 'fbx': 'fbx', 'usd': 'usdc'}[MODE])
    REPORT['source'] = str(source)
    if not source.exists():
        raise FileNotFoundError(source)
    if MODE == 'glb':
        bpy.ops.import_scene.gltf(filepath=str(source))
    elif MODE == 'blend':
        bpy.ops.wm.open_mainfile(filepath=str(source))
    elif MODE == 'fbx':
        REPORT['importOptions'] = {'use_anim': True, 'anim_offset': 0.0}
        REPORT['adapterDecision'] = 'Blender FBX importer defaults to a +1 frame offset; explicitly set anim_offset=0.0 for the project zero-based frame contract.'
        bpy.ops.import_scene.fbx(filepath=str(source), use_anim=True, anim_offset=0.0)
    elif MODE == 'usd':
        from pxr import Usd
        stage = Usd.Stage.Open(str(source))
        REPORT['usdStructure'] = {'skeletonPrims': [str(p.GetPath()) for p in stage.Traverse() if p.GetTypeName() == 'Skeleton'], 'animationPrims': [str(p.GetPath()) for p in stage.Traverse() if p.GetTypeName() == 'SkelAnimation'], 'upAxis': stage.GetMetadata('upAxis'), 'metersPerUnit': stage.GetMetadata('metersPerUnit'), 'timeCodesPerSecond': stage.GetTimeCodesPerSecond(), 'startTimeCode': stage.GetStartTimeCode(), 'endTimeCode': stage.GetEndTimeCode()}
        if not REPORT['usdStructure']['skeletonPrims'] or not REPORT['usdStructure']['animationPrims']:
            raise RuntimeError('USD is missing native Skeleton / SkelAnimation prims')
        bpy.ops.wm.usd_import(filepath=str(source))
    armature, meshes = validate_scene()
    if MODE == 'glb':
        ranges = action_ranges()
        bpy.context.scene.frame_start = math.floor(min(a['frameRange'][0] for a in ranges))
        bpy.context.scene.frame_end = math.ceil(max(a['frameRange'][1] for a in ranges))
        bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'rig.blend'))
        REPORT['exports']['blend'] = {'status': 'saved-awaiting-independent-reopen', 'path': str(OUT / 'rig.blend')}
        bpy.ops.object.select_all(action='DESELECT')
        for asset in [armature, *meshes]:
            asset.select_set(True)
        bpy.context.view_layer.objects.active = armature
        export_if_supported('FBX', bpy.ops.export_scene.fbx, {
            'filepath': str(OUT / 'rig.fbx'), 'use_selection': True, 'object_types': {'ARMATURE', 'MESH'},
            'add_leaf_bones': False, 'use_armature_deform_only': False, 'bake_anim': True,
            'bake_anim_use_all_actions': False, 'bake_anim_use_nla_strips': False,
            'bake_anim_simplify_factor': 0.0, 'axis_forward': '-Z', 'axis_up': 'Y',
        })
        export_if_supported('USD', bpy.ops.wm.usd_export, {
            'filepath': str(OUT / 'rig.usdc'), 'export_animation': True, 'export_armatures': True,
            'export_deform_bones_only': False, 'selected_objects_only': True,
        })
    REPORT['status'] = 'passed-in-blender'
    REPORT['targetSoftware']['Blender'] = 'passed synthetic fixture checks'
except Exception as error:
    import traceback
    REPORT['error'] = str(error)
    REPORT['traceback'] = traceback.format_exc()
finally:
    # bpy operators may contain sets in options; retain a stable JSON representation.
    report_path = REPORTS / f'dcc-{MODE}.json'
    report_path.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2, default=lambda obj: sorted(obj) if isinstance(obj, set) else str(obj)) + '\n')
    print('DCC_PROBE_RESULT', json.dumps({'mode': MODE, 'status': REPORT['status'], 'report': str(report_path), 'error': REPORT.get('error')}, ensure_ascii=False))
    if REPORT['status'] != 'passed-in-blender':
        raise SystemExit(1)
