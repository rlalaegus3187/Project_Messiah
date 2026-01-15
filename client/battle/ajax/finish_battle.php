<?php
include_once($_SERVER['DOCUMENT_ROOT'] . '/common.php');
header('Content-Type: application/json; charset=utf-8');

$raw = file_get_contents('php://input');
$req = json_decode($raw, true) ?: [];

// 로그인/권한 체크
if (!$is_member) {
    echo json_encode(['ok' => false, 'message' => '권한이 없습니다.']);
    exit;
}

try {
    sql_query("
            UPDATE avo_character
            SET ch_battle = 0,
                ch_status = 'NONE'
            WHERE ch_id = {$character["ch_id"]}
            LIMIT 1
        ");
} catch (Exception $e) {
    echo json_encode(['ok' => false, 'message' => $e->getMessage()]);
    exit;
}
