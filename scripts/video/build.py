# Assemblage de la vidéo à partir des images de film.js (lancer dans le dossier qui contient frames/ : FRAMES_DIR=./frames node film.js puis python3 build.py)
import json, subprocess, os
S=json.load(open('frames/scenes.json')); K=1.35
os.makedirs('parts',exist_ok=True); parts=[]
for name,imgs in S.items():
    lst=f'parts/{name}.txt'
    with open(lst,'w') as f:
        for p,h in imgs: f.write(f"file '{os.path.abspath(p)}'\nduration {max(h*K,0.08):.3f}\n")
        f.write(f"file '{os.path.abspath(imgs[-1][0])}'\n")
    dur=sum(max(h*K,0.08) for _,h in imgs)
    tmp=f'parts/{name}.tmp.mp4'; out=f'parts/{name}.mp4'
    vf=f"fps=30,format=yuv420p,fade=t=in:st=0:d=0.25,fade=t=out:st={dur-0.25:.3f}:d=0.25"
    r=subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',lst,'-vf',vf,'-t',f'{dur:.3f}','-c:v','libx264','-crf','20','-preset','veryfast','-pix_fmt','yuv420p','-r','30',tmp])
    if r.returncode==0: os.replace(tmp,out); parts.append(out)
    else: raise SystemExit('fail '+name)
with open('parts/all.txt','w') as f:
    for p in parts: f.write(f"file '{os.path.abspath(p)}'\n")
subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i','parts/all.txt','-c','copy','-movflags','+faststart','facturapro-premiere-facture.tmp.mp4'],check=True)
os.replace('facturapro-premiere-facture.tmp.mp4','facturapro-premiere-facture.mp4')
print(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=width,height,r_frame_rate','-of','compact','facturapro-premiere-facture.mp4'],capture_output=True,text=True).stdout)
