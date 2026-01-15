
export class SkillUI {
  constructor(){
    this.selected = null;
    this.keyMap = new Map();
    this.container = document.getElementById('skillBar');
    this.onSelect = null; // (skillObj|null) => void
    this.buttons = new Map(); // id -> {btn, cdEl, iconEl}
    this.cooldowns = {}; // {id: seconds}
    this.ap = 0;
    this.skills = [];
    this.alive = true;
    // tick
    this._lastTs = performance.now();
    this._tick = this._tick.bind(this);
    requestAnimationFrame(this._tick);
  }

  build(skills){
    console.log(skills);
    
    this.container.innerHTML=''; this.keyMap.clear(); this.buttons.clear();
    this.skills = skills.slice();
    this.skills.forEach(s=>{
      const btn = document.createElement('button');
      btn.className = 'skill-btn';
      btn.dataset.id = s.id;
      btn.title = `${s.name} (AP ${s.apCost ?? 0}${s.cooldown?`, CD ${s.cooldown}s`:''}${s.hotkey?`, ${s.hotkey}`:''})`;
			
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = s.name;
      btn.appendChild(label);

      const cd = document.createElement('div');
      cd.className = 'cd';
      cd.textContent = '';
      btn.appendChild(cd);

      btn.addEventListener('click', ()=> this.toggleSelect(s.id, s));

      this.container.appendChild(btn);
      if(s.hotkey) this.keyMap.set(s.hotkey, s.id);
      this.buttons.set(s.id, {btn, cdEl: cd});
    });

    window.addEventListener('keydown', (e)=>{
      const id = this.keyMap.get(e.key);
      if(id){
        const s = this.skills.find(x=>x.id===id);
        this.toggleSelect(id, s);
      }
			
    });

    this.refreshDisabled();
  }

  toggleSelect(id, skill){
    if(this.selected===id){
      this.clearSelection();
      return;
    }
    this.clearSelection();
    this.selected = id;
    const group = this.buttons.get(id);
    if(group) group.btn.classList.add('sel');
    if(this.onSelect) this.onSelect(skill);
  }

  clearSelection(){
    if(this.selected){
      const g = this.buttons.get(this.selected);
      if(g) g.btn.classList.remove('sel');
      this.selected = null;
      if(this.onSelect) this.onSelect(null);
    }
  }

  // HUD helpers expected by client.js
  updateAP(v){
    this.ap = v|0;
    this.refreshDisabled();
  }
  updateAlive(alive){
    this.alive = !!alive;
    this.refreshDisabled();
  }

  setCooldowns(cd){
    // cd: {id: sec}
    this.cooldowns = Object.assign({}, this.cooldowns, cd);
    this._renderCooldowns();
    this.refreshDisabled();
  }

  // call every frame
  _tick = (ts)=>{
    const dt = Math.min(0.1, (ts - this._lastTs) / 1000);
    this._lastTs = ts;
    // simple cooldown decay (visual only; server is source of truth updates via cd:update)
    let changed = false;
    for(const id in this.cooldowns){
      if(this.cooldowns[id] > 0){
        this.cooldowns[id] = Math.max(0, this.cooldowns[id] - dt);
        changed = true;
      }
    }
    if(changed){
      this._renderCooldowns();
      this.refreshDisabled();
    }
    requestAnimationFrame(this._tick);
  }

  _renderCooldowns(){
    for(const s of this.skills){
      const g = this.buttons.get(s.id);
      if(!g) continue;
      const left = this.cooldowns[s.id] || 0;
      if(left > 0.01){
        g.cdEl.textContent = Math.ceil(left).toString();
        g.btn.classList.add('cooling');
      }else{
        g.cdEl.textContent = '';
        g.btn.classList.remove('cooling');
      }
    }
  }

  refreshDisabled(){
    for(const s of this.skills){
      const g = this.buttons.get(s.id);
      if(!g) continue;
      const onCd = (this.cooldowns[s.id]||0) > 0.01;
      const lackAp = (this.ap||0) < (s.apCost||0);
      const dead = !this.alive;
      g.btn.disabled = dead || onCd || lackAp;
      if(g.btn.disabled && this.selected===s.id){
        this.clearSelection();
      }
    }
  }
}
