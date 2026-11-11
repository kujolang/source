"""Generate the requested Siren v4 once per cue; retain provenance and uncertain calls."""
import base64,hashlib,json,os,pathlib,subprocess,urllib.request,time
root=pathlib.Path(__file__).resolve().parents[1]
assert json.loads((root/'evidence/run.json').read_text())['status']=='passed', 'Narration must follow verified proof'
cues=[p.strip() for p in (root/'TRANSCRIPT.md').read_text().split('\n\n')[1:] if p.strip()]
key=os.environ.get('ELEVENLABS_API_KEY') or subprocess.check_output(['security','find-generic-password','-s','kujo-videoops-elevenlabs','-a','videoops','-w'],stderr=subprocess.DEVNULL,text=True).strip()
def request(path,payload=None):
 return urllib.request.urlopen(urllib.request.Request('https://api.elevenlabs.io/v1/'+path,data=json.dumps(payload).encode() if payload else None,headers={'xi-api-key':key,'Content-Type':'application/json'}),timeout=90)
with request('user/subscription') as r:tier=json.load(r)['tier']
assert tier not in ('free','unknown')
records=[]
for i,text in enumerate(cues):
 name=f'voice-{i}';voice='eXpIbVcVbLo8ZJQDlDnl';payload={'text':text,'model_id':'eleven_v4','voice_settings':{'stability':0.5,'similarity_boost':0.75}}
 signature=hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest();file=root/'assets'/f'{name}.mp3';receipt=root/'evidence'/f'{name}.json';pending=root/'evidence'/f'{name}.pending'
 if file.exists() and receipt.exists():
  old=json.loads(receipt.read_text());assert old['request_sha256']==signature;records.append(old);continue
 assert not pending.exists(),'Reconcile uncertain provider request before retrying'
 pending.write_text(signature)
 with request('text-to-speech/'+voice+'/with-timestamps?output_format=mp3_44100_128',payload) as r:
  result=json.load(r);audio=base64.b64decode(result['audio_base64']);request_id=r.headers.get('request-id')
 file.write_bytes(audio)
 (root/'evidence'/f'alignment-{i}.json').write_text(json.dumps(result.get('alignment') or result['normalized_alignment']))
 duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(file)],text=True))
 record={'cue':i,'text':text,'provider':'ElevenLabs','model':'eleven_v4','voice':'Siren','voice_id':voice,'generation_tier':tier,'duration':duration,'request_id':request_id,'request_sha256':signature,'audio_sha256':hashlib.sha256(audio).hexdigest(),'generated_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
 receipt.write_text(json.dumps(record,indent=2));pending.unlink();records.append(record);print(i,duration,flush=True)
(root/'evidence/narration.json').write_text(json.dumps(records,indent=2))
