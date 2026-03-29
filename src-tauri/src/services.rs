use futures::TryStreamExt;
use mongodb::{bson, bson::Document, options::FindOptions, Client};


fn main() {
    let db_url = "mongodb+srv://carmelodiventi_db_user:6kWny0hOvmSNccbt@cluster0.s4n2h2u.mongodb.net/?appName=Cluster0";

    let options = ClientOptions::parse(db_url).expect("invalid database url");

    let client = Client::with_options(options).unwrap();

    tauri::Builder::default()
        // let's register `client` as a state. We'll be able to access it from the function
        // with tauri::State<Client>
        .manage(client)
        // register handler here
        .invoke_handler(tauri::generate_handler![db_find])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn db_find(
    client: tauri::State<'_, Client>,
    collection: String,
    filter: bson::Document,
) -> Result<Vec<Document>, ()> {
    let db = client.default_database().unwrap();
    let target_collection = db.collection::<Document>(&collection);
    let mut cursor = target_collection
        .find(filter, FindOptions::default())
        .await
        .unwrap();

    let mut results = Vec::new();
    while let Some(result) = cursor.try_next().await.unwrap() {
        results.push(result);
    }

    Ok(results)
}