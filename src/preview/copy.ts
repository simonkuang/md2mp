/**
 * 预览页内置复制脚本（内联 <script>，仅存在于 preview.html，永不进入 article.html）。
 * 策略：Selection + execCommand('copy') 为主，ClipboardItem 写 text/html 为兜底。
 */
export const COPY_SCRIPT = `
(function(){
  function byId(id){return document.getElementById(id);}
  function toast(msg){
    var t=byId('__md2mp_toast'); if(!t)return;
    t.textContent=msg; t.classList.add('show');
    clearTimeout(t._timer); t._timer=setTimeout(function(){t.classList.remove('show');},2200);
  }
  function copySelection(){
    var root=byId('__md2mp_article');
    if(!root)return Promise.reject(new Error('no article'));
    var sel=window.getSelection(); var range=document.createRange();
    range.selectNodeContents(root); sel.removeAllRanges(); sel.addRange(range);
    var ok=false;
    try{ ok=document.execCommand('copy'); }catch(e){ ok=false; }
    sel.removeAllRanges();
    return ok?Promise.resolve():Promise.reject(new Error('execCommand failed'));
  }
  function copyClipboardItem(){
    if(!navigator.clipboard||!window.ClipboardItem)return Promise.reject(new Error('no clipboard api'));
    var root=byId('__md2mp_article');
    var html=root?root.innerHTML:'';
    var item=new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([root?root.innerText:''],{type:'text/plain'})});
    return navigator.clipboard.write([item]);
  }
  function copy(){
    copySelection().then(function(){
      toast('已复制，去公众号编辑器粘贴即可');
    }).catch(function(){
      return copyClipboardItem().then(function(){
        toast('已复制（Clipboard API），去公众号编辑器粘贴即可');
      });
    }).catch(function(){
      toast('复制失败，请手动全选文章区域复制');
    });
  }
  function copyText(){
    var root=byId('__md2mp_article'); var text=root?root.innerText:'';
    var ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta);
    ta.select(); try{document.execCommand('copy');toast('已复制纯文本');}catch(e){toast('复制失败');}
    document.body.removeChild(ta);
  }
  window.__md2mpCopy=copy;
  document.addEventListener('DOMContentLoaded',function(){
    var b=byId('__md2mp_copy'); if(b)b.addEventListener('click',copy);
    var t=byId('__md2mp_copy_text'); if(t)t.addEventListener('click',copyText);
    var p=byId('__md2mp_lint_toggle'); if(p)p.addEventListener('click',function(){
      var panel=byId('__md2mp_warnings'); if(panel)panel.classList.toggle('collapsed');
    });
  });
})();
`;
