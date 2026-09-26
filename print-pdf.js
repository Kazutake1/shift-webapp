// iPad Safari adds its own footer when printing HTML. Render the existing print
// layout to a single A4 PDF page so the table dimensions remain unchanged.
const PAGE_WIDTH_MM=297;
const PAGE_HEIGHT_MM=210;
const TABLE_WIDTH_MM=281;
const DPI=240;

function pdfFromJpeg(jpeg,width,height){
 const encoder=new TextEncoder();
 const chunks=[];
 let length=0;
 const append=bytes=>{chunks.push(bytes);length+=bytes.length;};
 const ascii=value=>append(encoder.encode(value));
 const offsets=[0];
 const object=(id,body)=>{
  offsets[id]=length;
  ascii(`${id} 0 obj\n${body}\nendobj\n`);
 };
 ascii('%PDF-1.4\n');
 object(1,'<< /Type /Catalog /Pages 2 0 R >>');
 object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
 object(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
 offsets[4]=length;
 ascii(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
 append(jpeg);
 ascii('\nendstream\nendobj\n');
 const content='q\n841.89 0 0 595.28 0 0 cm\n/Im0 Do\nQ\n';
 object(5,`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`);
 const xref=length;
 ascii('xref\n0 6\n0000000000 65535 f \n');
 for(let id=1;id<=5;id++)ascii(`${String(offsets[id]).padStart(10,'0')} 00000 n \n`);
 ascii(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
 return new Blob(chunks,{type:'application/pdf'});
}

function renderPaper(paper){
 const rect=paper.getBoundingClientRect();
 if(!rect.width||!rect.height)throw new Error('シフト表の表示寸法を取得できません。');
 const pixelsPerMm=rect.width/TABLE_WIDTH_MM;
 const heightMm=rect.height/pixelsPerMm;
 if(heightMm>PAGE_HEIGHT_MM-12)throw new Error('シフト表がA4横の印刷範囲を超えています。');
 const canvas=document.createElement('canvas');
 canvas.width=Math.round(PAGE_WIDTH_MM/25.4*DPI);
 canvas.height=Math.round(PAGE_HEIGHT_MM/25.4*DPI);
 const ctx=canvas.getContext('2d');
 if(!ctx)throw new Error('印刷用画像を作成できません。');
 const scale=canvas.width/(PAGE_WIDTH_MM*pixelsPerMm);
 const left=8*canvas.width/PAGE_WIDTH_MM;
 const top=(PAGE_HEIGHT_MM-heightMm)/2*canvas.height/PAGE_HEIGHT_MM;
 const x=value=>left+(value-rect.left)*scale;
 const y=value=>top+(value-rect.top)*scale;
 ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);

 // Draw the existing collapsed table borders, followed by its positioned text.
 for(const element of paper.querySelectorAll('#schedule,#schedule th,#schedule td')){
  const r=element.getBoundingClientRect(),style=getComputedStyle(element);
  for(const [side,rx,ry,rw,rh] of [
   ['Top',r.left,r.top,r.width,0],['Right',r.right,r.top,0,r.height],
   ['Bottom',r.left,r.bottom,r.width,0],['Left',r.left,r.top,0,r.height]
  ]){
   const color=style[`border${side}Color`],width=parseFloat(style[`border${side}Width`]);
   if(!width||style[`border${side}Style`]==='none'||color==='transparent'||/rgba?\([^)]*,\s*0(?:\.0+)?\)$/.test(color))continue;
   ctx.fillStyle=color;
   if(side==='Top'||side==='Bottom')ctx.fillRect(x(rx),y(ry)-(side==='Bottom'?width*scale:0),rw*scale,width*scale);
   else ctx.fillRect(x(rx)-(side==='Right'?width*scale:0),y(ry),width*scale,rh*scale);
  }
 }
 const walker=document.createTreeWalker(paper,NodeFilter.SHOW_TEXT);
 const range=document.createRange();
 while(walker.nextNode()){
  const node=walker.currentNode,parent=node.parentElement;
  if(!parent||!node.textContent.trim()||parent.closest('svg,[hidden]'))continue;
  const style=getComputedStyle(parent);
  if(style.display==='none'||style.visibility==='hidden')continue;
  ctx.font=`${style.fontStyle} ${style.fontWeight} ${parseFloat(style.fontSize)*scale}px ${style.fontFamily}`;
  ctx.textBaseline='alphabetic';ctx.fillStyle=style.color;
  let offset=0;
  for(const glyph of node.textContent){
   const end=offset+glyph.length;
   if(!/\s/.test(glyph)){
    range.setStart(node,offset);range.setEnd(node,end);
    const r=range.getBoundingClientRect();
    if(r.width&&r.height){
     const metrics=ctx.measureText(glyph);
     const ascent=metrics.actualBoundingBoxAscent||parseFloat(style.fontSize)*scale*.8;
     const descent=metrics.actualBoundingBoxDescent||0;
     ctx.fillText(glyph,x(r.left),y((r.top+r.bottom)/2)+(ascent-descent)/2);
    }
   }
   offset=end;
  }
 }
 range.detach?.();

 // The app already measures every heavy rule against the live table cells.
 const rules=paper.querySelector('.table-rules');
 if(rules){
  const svg=rules.getBoundingClientRect();
  for(const line of rules.querySelectorAll('line')){
   ctx.beginPath();ctx.strokeStyle=line.getAttribute('stroke')||'#111';
   ctx.lineWidth=(Number(line.getAttribute('stroke-width'))||1)*scale;
   ctx.moveTo(x(svg.left+Number(line.getAttribute('x1'))),y(svg.top+Number(line.getAttribute('y1'))));
   ctx.lineTo(x(svg.left+Number(line.getAttribute('x2'))),y(svg.top+Number(line.getAttribute('y2'))));
   ctx.stroke();
  }
 }
 return canvas;
}

export async function createPrintPdf(paper){
 const canvas=renderPaper(paper);
 const jpegBlob=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('印刷用画像を作成できません。')),'image/jpeg',.96));
 const jpeg=new Uint8Array(await jpegBlob.arrayBuffer());
 return pdfFromJpeg(jpeg,canvas.width,canvas.height);
}
