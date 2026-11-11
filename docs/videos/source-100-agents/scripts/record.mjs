// Record a live browser console of actual benchmark stdout. No replay or invented state.
const { default: puppeteer } = await import(process.env.SOURCE_VIDEO_PUPPETEER || 'puppeteer-core');
import { spawn } from 'node:child_process';
import { writeFile, appendFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(project, '../../..');
if (!process.env.SOURCE_TEST_DATABASE_URL) throw new Error('Set SOURCE_TEST_DATABASE_URL to an owned disposable database');
for (const file of ['assets/raw-run.webm', 'evidence/run.json', 'evidence/events.jsonl']) {
  let exists = true; try { await access(path.join(project, file)); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
  if (exists) throw new Error(`Refusing to overwrite ${file}; archive the prior take first`);
}
const browser = await puppeteer.launch({executablePath:process.env.SOURCE_VIDEO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--window-size=1920,1080','--force-device-scale-factor=1'],defaultViewport:{width:1920,height:1080,deviceScaleFactor:1}});
const page = await browser.newPage();
await page.setContent(await readFile(path.join(project,'scripts/console.html'),'utf8'));
const recording = await page.screencast({path:path.join(project,'assets/raw-run.webm'),fps:10,scale:0.5,ffmpegPath:'/usr/local/bin/ffmpeg'});
const start = Date.now();
const evidence = path.join(project,'evidence/events.jsonl');
await writeFile(evidence,'');
const child = spawn(process.execPath,['scripts/benchmarks/integration.js','--agents','100','--repos','1','--profile','private-load','--same-file','--keyed-submissions','--progress','--output',path.join(project,'evidence/run.json')],{cwd:repo,env:{...process.env,PATH:'/usr/bin:'+process.env.PATH,SOURCE_TEST_DATABASE_URL:process.env.SOURCE_TEST_DATABASE_URL},stdio:['ignore','pipe','pipe']});
let queue=Promise.resolve(),buffer='';
child.stdout.on('data',data=>{
 buffer+=data;
 while(buffer.includes('\n')) { const at=buffer.indexOf('\n'),line=buffer.slice(0,at);buffer=buffer.slice(at+1);let event;try{event=JSON.parse(line);}catch{continue;}
 const frame={...event,recordingSeconds:(Date.now()-start)/1000};
 queue=queue.then(async()=>{await appendFile(evidence,JSON.stringify(frame)+'\n');await page.evaluate(e=>window.consume(e),frame);});
 console.log(JSON.stringify(frame.event==='diff'?{event:'diff',index:frame.index}:frame));
 }
});
child.stderr.on('data',data=>process.stderr.write(data));
const code=await new Promise(resolve=>child.on('close',resolve));
await queue;
await new Promise(r=>setTimeout(r,4000));
await page.screenshot({path:path.join(project,'evidence/final-console.png')});
await recording.stop();await browser.close();
await writeFile(path.join(project,'evidence/recording.json'),JSON.stringify({startedAt:new Date(start).toISOString(),durationSeconds:(Date.now()-start)/1000,exitCode:code,method:'Puppeteer real-time browser screencast of live benchmark stdout; custom test console, not product UI'},null,2));
process.exitCode=code;
