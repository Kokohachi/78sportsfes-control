# 組別得点スプレッドシートの作成

アプリは組別得点の集計をFirestoreの `public_scoreboards/ball_day` と `public_scoreboards/team_day` に同期します。Google Apps Scriptはこの2つを1分ごとに読み、1つのGoogleスプレッドシートにある「球技日」「団体競技日」タブを更新します。

1. `https://script.google.com/home/projects/create` を開きます。
2. エディタの内容を `live-scoreboard.gs` の内容に置き換えて保存します。
3. `createLiveScoreSpreadsheet` を選んで実行し、Googleの権限確認を完了します。
4. 実行ログに表示されるスプレッドシートURLを開きます。新しいファイルは初期状態で自分だけが見られます。共有する場合は、Google Driveの共有設定で閲覧者を追加してください。

Apps Scriptの時間主導トリガーは約1分ごとに動作します。Google側の実行タイミングにより多少遅れることがあります。アプリが一度Firestoreへ同期すると各タブに得点が表示されます。

この表に書き出すのは競技・区分・組別得点と合計点だけで、個人情報は含みません。Firestore上の得点フィードは公開情報として扱ってください。
