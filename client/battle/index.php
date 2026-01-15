<?php
include_once('./_common.php');
include_once('./_head.php');

$raidId   = isset($_GET['raidId'])   ? trim($_GET['raidId'])   : null;
$isViewer = isset($_GET['isViewer']) && $_GET['isViewer'] === 'true';

if ($character["ch_status"] != "IN_BATTLE" && !$isViewer) {
  header("Location: https://scenario-messiah.com");
  exit;
}
?>
<style>
  .ban-basic {
    display: none;
  }
</style>

<link rel="stylesheet" href="styles.css" />

<body class="raid">
  <div id="ui">
    <div class="hud glass">
      <div class="col">
        <div><strong id="youName">-</strong></div>
        <div>HP <span id="youHP">-</span> AP <span id="youAP">-</span></div>
      </div>
      <div class="skills" id="skillBar"></div>
    </div>
    <div id="announce" class="announce"></div>
    <div id="battle_ch_list" class="glass"> </div>
  </div>

  <div id="game"></div>
  <!-- Combat Log -->
  <div id="log" class="log glass"></div>

  <div id="result" class="hidden">
    <div id="result-title"></div>
    <div id="result-detail"></div>
    <div id="result-reward"></div>
    <button id="result-ok">확인</button>
  </div>

  <? include(G5_PATH . '/chat/index.php'); ?>
</body>

<script>
  window.raidId = <?=
                  $raidId === null
                    ? 'window.teamId' : $raidId
                  ?>;
  window.isViewer = <?= $isViewer ? 'true' : 'false' ?>;
</script>

<script src="https://scenario-messiah.com/public/js/socket.io.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pixi.js/7.4.0/pixi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/pixi-filters@latest/dist/browser/pixi-filters.min.js"></script>

<script type="module" src="net.js"></script>
<script type="module" src="hud.js"></script>
<script type="module" src="grid.js"></script>
<script type="module" src="skills.js"></script>
<script type="module" src="client.js"></script>

<?php
include_once('./_tail.php');

?>
