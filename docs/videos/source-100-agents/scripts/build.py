"""Build the editable edit from real recordings and generated voice receipts."""
import json,pathlib,subprocess,math,html,sys
root=pathlib.Path(__file__).resolve().parents[1]
def run(*args):
 if '--reuse-media' in sys.argv and args[0]=='ffmpeg':
  if args[-1] not in ('assets/voice.wav', 'assets/music-bed.wav'):
   assert (root/args[-1]).exists(), f'Missing cached media: {args[-1]}'
  return
 subprocess.run(args,cwd=root,check=True)
voices=json.loads((root/'evidence/narration.json').read_text());durations=[math.ceil((v['duration']+.6)*30)/30 for v in voices];durations[-1]+=1
starts=[];total=0
for d in durations:starts.append(total);total+=d
# Footage source times map to timestamped real events. Cuts are explicit.
shots=[(0,75,2,durations[0]-2),(1,18,0,durations[1]),(2,104,0,durations[2]),(3,152.5,0,durations[3]),(4,170,0,4),(4,242,4,durations[4]-4)]
clips=[]
for n,(scene,source,local,duration) in enumerate(shots):
 # Last evidence shot freezes the actual final frame to keep the proof readable.
 file=f'assets/shot-{n}.mp4'
 run('ffmpeg','-y','-v','error','-ss',str(source),'-i','assets/raw-run.mp4','-t',str(duration),'-vf','tpad=stop_mode=clone:stop_duration=15,fps=30','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p',file)
 clips.append({'scene':scene,'file':file,'start':local,'duration':duration,'sourceStart':source})
(root/'evidence/edit-map.json').write_text(json.dumps({'duration':total,'starts':starts,'durations':durations,'clips':clips},indent=2))
# Voice timing is preserved; original music loop is crossfaded, then mixed quietly.
inputs=[];filters=[];labels=[]
for i,v in enumerate(voices):
 inputs+=['-i',f'assets/voice-{i}.mp3'];delay=round((starts[i]+.15)*1000)
 filters.append(f'[{i}:a]adelay={delay}|{delay}[v{i}]');labels.append(f'[v{i}]')
filters.append(''.join(labels)+f'amix=inputs={len(labels)}:normalize=0,apad,atrim=0:{total}[voice]')
run('ffmpeg','-y','-v','error',*inputs,'-filter_complex',';'.join(filters),'-map','[voice]','assets/voice.wav')
run('ffmpeg','-y','-v','error',*sum((['-i','assets/music-original.wav'] for _ in range(5)),[]),'-filter_complex','[0:a][1:a]acrossfade=d=1[m1];[m1][2:a]acrossfade=d=1[m2];[m2][3:a]acrossfade=d=1[m3];[m3][4:a]acrossfade=d=1,volume=0.12,afade=t=in:d=0.4,afade=t=out:st='+str(total-2)+':d=2[music]','-map','[music]','-t',str(total),'assets/music-bed.wav')
run('ffmpeg','-y','-v','error','-i','assets/voice.wav','-i','assets/music-bed.wav','-filter_complex','[0:a][1:a]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=9','-t',str(total),'-c:a','aac','-b:a','192k','assets/master.m4a')
common='''@font-face{font-family:Departure Mono;src:url('assets/fonts/DepartureMono-Regular.woff2') format('woff2');font-style:normal;font-weight:400;font-display:block}#root{position:absolute;inset:0;background:#f4f5f3;color:#111615;font-family:Inter,sans-serif;overflow:hidden}*{box-sizing:border-box}h1{margin:0;font-family:Departure Mono,monospace;font-size:112px;line-height:1.12;letter-spacing:-2px;font-weight:400}.brand-mark{display:block;width:144px;height:144px;margin-bottom:36px}p{font-size:38px;line-height:1.35;margin:30px 0 0}.copy{position:absolute;left:192px;right:192px;top:190px}.line{overflow:hidden}.bar{width:112px;height:10px;background:#111615;margin-bottom:55px}.note{position:absolute;bottom:104px;left:192px;font-size:28px;color:#47534b}video{position:absolute;inset:0;width:1920px;height:1080px;object-fit:contain}'''
for i,d in enumerate(durations):
 parts=[]
 if i==0:parts.append('<div class="clip" id="hook-card" data-start="0" data-duration="2"><div class="copy"><h1>100 agents.<br>One shared file.</h1></div></div>')
 for n,c in enumerate(clips):
  if c['scene']==i:parts.append(f'<video id="footage-{n}" class="clip" data-start="{c["start"]}" data-duration="{c["duration"]}" src="{c["file"]}" muted playsinline></video>')
 if i==5:parts.append(f'<div class="clip" id="scope-card" data-hold data-start="0" data-duration="{d}"><div class="copy"><div class="bar"></div><h1>Same file.<br>Separate sections.</h1><p>This run tests compatible edits.</p></div><div class="note">100 scripted processes · local fixture · cuts shown</div></div>')
 if i==6:parts.append(f'<div class="clip" id="close-card" data-hold data-start="0" data-duration="{d}"><div class="copy"><img id="kujo-mark" class="brand-mark" src="assets/kujo-logomark.svg" alt="Kujo"><h1>Source <span style="font-weight:400">0.2.0</span></h1><p>Try it alongside your current setup.</p><p style="margin-top:65px;font-size:44px">github.com/kujolang/source</p></div></div>')
 if i in [1,2,3,4]:parts.append(f'<div id="cut-label-{i}" class="clip" data-start="0" data-duration="{d}" style="position:absolute;left:1280px;top:38px;width:560px;height:54px;background:#111615;color:#d8e1dc;font-size:28px;text-align:right;z-index:8">RECORDED LIVE · EDITED EXCERPTS</div>')
 motion=''
 if i in [0,5,6]:motion="tl.fromTo('.copy',{x:80},{x:0,duration:.4,ease:'power3.out'},0);"
 content=f'<template><style>{common}</style><div id="root" data-composition-id="scene{i}" data-width="1920" data-height="1080">'+''.join(parts)+f'</div><script>const tl=gsap.timeline({{paused:true}});{motion}window.__timelines["scene{i}"]=tl;</script></template>'
 (root/f'compositions/scene{i}.html').write_text(content)
hosts=''.join(f'<div id="scene{i}" class="clip" data-composition-id="scene{i}" data-composition-src="compositions/scene{i}.html" data-start="{starts[i]}" data-duration="{d}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>' for i,d in enumerate(durations))
(root/'index.html').write_text(f'<!doctype html><html lang="en"><head><meta charset="UTF-8"><script src="assets/gsap.min.js"></script><style>*{{margin:0;padding:0;box-sizing:border-box}}html,body{{width:1920px;height:1080px;overflow:hidden;background:#111615}}#root{{position:relative;width:1920px;height:1080px}}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="{total}" data-width="1920" data-height="1080">{hosts}<audio id="master" class="clip" src="assets/master.m4a" data-start="0" data-duration="{total}" data-track-index="2" data-volume="1"></audio></div><script>window.__timelines=window.__timelines||{{}};window.__timelines.main=gsap.timeline({{paused:true}});</script></body></html>')
print('Built',total,'seconds')
