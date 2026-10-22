import { IcPhoto, IcStitch } from '../ui/icons';

export function App() {
  return (
    <div class="home">
      <h1>Stitch</h1>
      <p class="lead">Edit, overlay, mask and stitch photos. Everything stays on your phone.</p>
      <button class="home-card" disabled>
        <div class="ic" style={{ background: 'linear-gradient(135deg,#ffb35c,#ff5e7a)' }}>
          <IcPhoto />
        </div>
        <div>
          <h2>Edit a photo</h2>
          <span>Coming soon</span>
        </div>
      </button>
      <button class="home-card" disabled>
        <div class="ic" style={{ background: 'linear-gradient(135deg,#5ce1e6,#5b7cff)' }}>
          <IcStitch />
        </div>
        <div>
          <h2>Stitch photos</h2>
          <span>Coming soon</span>
        </div>
      </button>
      <div class="foot">Build {__BUILD__}</div>
    </div>
  );
}
